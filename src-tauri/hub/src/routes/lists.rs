//! /api/v1/lists, /api/v1/meals and /api/v1/notifications (routes/lists.ts,
//! routes/meals.ts, routes/notifications.ts).

use crate::auth::User;
use crate::db::{self, defined, is_iso_date, js_string, Row};
use crate::hometime::weekday;
use crate::household::{caller_member, log_activity, manages, write_log, LogEntry};
use crate::http::{created, error, no_content, ok, Body};
use crate::{p, try_run, realtime, store, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::Router;
use serde_json::{json, Value};
use std::sync::Arc;

// ---- Lists ---------------------------------------------------------------------------------

pub fn lists() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(all_lists).post(add_list))
        .route("/{id}", patch(edit_list).delete(remove_list))
        .route("/{id}/items", post(add_item))
        .route("/{id}/items/{item_id}", patch(edit_item).delete(remove_item))
        .route("/{id}/clear-done", post(clear_done))
}

const NOT_MANAGER: &str = "Ask a parent to change the lists.";

pub fn row_to_item(i: &Row) -> Value {
    json!({ "id": i["id"], "listId": i["list_id"], "label": i["label"], "done": db::bool(i, "done"), "position": i["position"], "addedBy": db::opt(i, "added_by"), "createdAt": i["created_at"] })
}

fn checklist(hub: &Hub, l: &Row) -> Value {
    let items = db::all(&hub.store.db(), "SELECT * FROM list_items WHERE list_id = ? ORDER BY position, created_at", p![l["id"].clone()]);
    json!({ "id": l["id"], "householdId": l["household_id"], "title": l["title"], "color": l["color"], "createdAt": l["created_at"], "items": items.iter().map(row_to_item).collect::<Vec<_>>() })
}

fn fetch_checklist(hub: &Hub, id: &str, household: &str) -> Value {
    let list = db::one(&hub.store.db(), "SELECT * FROM lists WHERE id = ? AND household_id = ?", p![id, household]);
    list.map(|l| checklist(hub, &l)).unwrap_or(Value::Null)
}

fn list_exists(hub: &Hub, id: &str, household: &str) -> bool {
    db::one(&hub.store.db(), "SELECT id FROM lists WHERE id = ? AND household_id = ?", p![id, household]).is_some()
}

/// List managers can change any item; everyone else only the ones they added.
fn may_change_item(hub: &Hub, user: &User, added_by: Option<&str>) -> bool {
    manages(hub, user, "lists") || caller_member(hub, user).is_some_and(|m| added_by == Some(m.id.as_str()))
}

async fn all_lists(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let lists = db::all(&hub.store.db(), "SELECT * FROM lists WHERE household_id = ? ORDER BY created_at", p![user.household_id.clone()]);
    ok(Value::Array(lists.iter().map(|l| checklist(&hub, l)).collect()))
}

async fn add_list(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !manages(&hub, &user, "lists") {
        return error(403, NOT_MANAGER);
    }
    let Some(title) = body.text("title") else { return error(400, "title is required.") };
    let id = store::uuid();
    try_run!(&hub.store.db(), "INSERT INTO lists (id, household_id, title, color) VALUES (?, ?, ?, ?)", p![id, household, title, body.raw("color").cloned().unwrap_or(json!("blue"))]);
    let list = fetch_checklist(&hub, &id, &household);
    log_activity(&hub, &user, "list.create", "list", Some(&id), &title, json!({}));
    realtime::broadcast(&hub, &household, "lists:created", list.clone());
    created(list)
}

async fn edit_list(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !manages(&hub, &user, "lists") {
        return error(403, NOT_MANAGER);
    }
    if !list_exists(&hub, &id, &household) {
        return error(404, "List not found.");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("title") { sets.push("title = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if let Some(v) = body.raw("color") { sets.push("color = ?"); vals.push(db::Bind::bind(v)); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    try_run!(&hub.store.db(), &format!("UPDATE lists SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    let list = fetch_checklist(&hub, &id, &household);
    realtime::broadcast(&hub, &household, "lists:updated", list.clone());
    ok(list)
}

async fn remove_list(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !manages(&hub, &user, "lists") {
        return error(403, NOT_MANAGER);
    }
    let gone = db::one(&hub.store.db(), "SELECT title FROM lists WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(gone) = gone else { return error(404, "List not found.") };
    try_run!(&hub.store.db(), "DELETE FROM lists WHERE id = ? AND household_id = ?", p![id, household]);
    log_activity(&hub, &user, "list.delete", "list", Some(&id), &db::s(&gone, "title"), json!({}));
    realtime::broadcast(&hub, &household, "lists:deleted", json!(id));
    no_content()
}

async fn add_item(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let Some(label) = body.text("label") else { return error(400, "label is required.") };
    if !list_exists(&hub, &id, &household) {
        return error(404, "List not found.");
    }
    let added_by = caller_member(&hub, &user).map(|m| m.id);
    {
        let db_ = hub.store.db();
        let max = db::one(&db_, "SELECT MAX(position) as m FROM list_items WHERE list_id = ?", p![id]).and_then(|r| r.get("m").and_then(Value::as_f64)).unwrap_or(-1.0);
        try_run!(&db_, "INSERT INTO list_items (id, list_id, label, done, position, added_by) VALUES (?, ?, ?, 0, ?, ?)", p![store::uuid(), id, label, max + 1.0, added_by]);
    }
    let list = fetch_checklist(&hub, &id, &household);
    realtime::broadcast(&hub, &household, "lists:updated", list.clone());
    created(list)
}

async fn edit_item(State(hub): State<Arc<Hub>>, user: User, Path((id, item_id)): Path<(String, String)>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !list_exists(&hub, &id, &household) {
        return error(404, "List not found.");
    }
    let item = db::one(&hub.store.db(), "SELECT added_by FROM list_items WHERE id = ? AND list_id = ?", p![item_id, id]);
    let Some(item) = item else { return error(404, "Item not found.") };
    if (body.has("label") || body.has("position")) && !may_change_item(&hub, &user, db::text(&item, "added_by").as_deref()) {
        return error(403, "Only whoever added it, or a parent, can change this item.");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("label") { sets.push("label = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if let Some(v) = body.raw("done") { sets.push("done = ?"); vals.push(db::Bind::bind(&db::truthy(Some(v)))); }
    if let Some(v) = body.raw("position") { sets.push("position = ?"); vals.push(db::Bind::bind(v)); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![item_id, id]);
    try_run!(&hub.store.db(), &format!("UPDATE list_items SET {} WHERE id = ? AND list_id = ?", sets.join(", ")), vals);
    let list = fetch_checklist(&hub, &id, &household);
    realtime::broadcast(&hub, &household, "lists:updated", list.clone());
    ok(list)
}

async fn remove_item(State(hub): State<Arc<Hub>>, user: User, Path((id, item_id)): Path<(String, String)>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !list_exists(&hub, &id, &household) {
        return error(404, "List not found.");
    }
    let item = db::one(&hub.store.db(), "SELECT added_by FROM list_items WHERE id = ? AND list_id = ?", p![item_id, id]);
    if item.as_ref().is_some_and(|i| !may_change_item(&hub, &user, db::text(i, "added_by").as_deref())) {
        return error(403, "Only whoever added it, or a parent, can remove this item.");
    }
    try_run!(&hub.store.db(), "DELETE FROM list_items WHERE id = ? AND list_id = ?", p![item_id, id]);
    let list = fetch_checklist(&hub, &id, &household);
    realtime::broadcast(&hub, &household, "lists:updated", list.clone());
    ok(list)
}

async fn clear_done(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !manages(&hub, &user, "lists") {
        return error(403, NOT_MANAGER);
    }
    if !list_exists(&hub, &id, &household) {
        return error(404, "List not found.");
    }
    try_run!(&hub.store.db(), "DELETE FROM list_items WHERE list_id = ? AND done = 1", p![id]);
    let list = fetch_checklist(&hub, &id, &household);
    realtime::broadcast(&hub, &household, "lists:updated", list.clone());
    ok(list)
}

// ---- Meals ----------------------------------------------------------------------------------

pub fn meals() -> Router<Arc<Hub>> {
    Router::new().route("/", get(all_meals).post(add_meal)).route("/{id}", patch(edit_meal).delete(remove_meal))
}

const DAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const NOT_MEALS: &str = "Ask a parent to change the meal plan.";

/// Up to 60 trimmed, non-empty grocery lines.
fn ingredients_column(v: Option<&Value>) -> String {
    let lines: Vec<String> = match v {
        Some(Value::Array(a)) => a.iter().map(js_string).collect(),
        Some(Value::String(s)) => s.split('\n').map(str::to_string).collect(),
        _ => Vec::new(),
    };
    let out: Vec<String> = lines.iter().map(|l| l.trim().chars().take(80).collect::<String>()).filter(|l| !l.is_empty()).take(60).collect();
    json!(out).to_string()
}

pub fn row_to_meal(r: &Row) -> Value {
    defined(
        json!({
            "date": db::opt(r, "date"), "ingredients": db::json_col(r, "ingredients", json!([])), "id": r["id"], "householdId": r["household_id"],
            "memberId": db::opt(r, "member_id"), "day": r["day"], "name": r["name"], "type": r["type"], "image": db::opt(r, "image"), "createdAt": r["created_at"],
        }),
        &["id", "householdId", "day", "name", "type", "createdAt"],
    )
}

async fn all_meals(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM meals WHERE household_id = ? ORDER BY day, created_at", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(row_to_meal).collect()))
}

async fn add_meal(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if !manages(&hub, &user, "meals") {
        return error(403, NOT_MEALS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let date = body.raw("date").filter(|d| is_iso_date(Some(d))).and_then(Value::as_str).map(str::to_string);
    let day = match &date {
        Some(d) => Some(json!(DAYS[weekday(d) as usize])),
        None => body.raw("day").cloned(),
    };
    let name = body.text("name");
    let (Some(day), Some(name)) = (day.filter(|d| db::truthy(Some(d))), name) else { return error(400, "day (or date) and name are required.") };
    let id = store::uuid();
    let db_ = hub.store.db();
    try_run!(&db_, "INSERT INTO meals (id, household_id, member_id, day, name, type, image, date, ingredients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        p![id, household, body.get("memberId").cloned(), day, name, body.raw("type").cloned().unwrap_or(json!("dinner")), body.get("image").cloned(), date, ingredients_column(body.raw("ingredients"))]);
    let meal = db::one(&db_, "SELECT * FROM meals WHERE id = ?", p![id]).map(|r| row_to_meal(&r)).unwrap_or(Value::Null);
    drop(db_);
    realtime::broadcast(&hub, &household, "meals:created", meal.clone());
    write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&user.sub), actor_name: None, action: "meal.create", resource_type: "meal", resource_id: Some(&id), resource_name: &name, metadata: json!({}) });
    created(meal)
}

async fn edit_meal(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if !manages(&hub, &user, "meals") {
        return error(403, NOT_MEALS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    if db::one(&hub.store.db(), "SELECT id FROM meals WHERE id = ? AND household_id = ?", p![id, household]).is_none() {
        return error(404, "Meal not found.");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("day") { sets.push("day = ?"); vals.push(db::Bind::bind(v)); }
    if let Some(v) = body.raw("name") { sets.push("name = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if let Some(v) = body.raw("type") { sets.push("type = ?"); vals.push(db::Bind::bind(v)); }
    if body.has("image") { sets.push("image = ?"); vals.push(db::Bind::bind(&body.get("image").cloned())); }
    if body.has("memberId") { sets.push("member_id = ?"); vals.push(db::Bind::bind(&body.get("memberId").cloned())); }
    if body.has("date") {
        let date = body.raw("date").filter(|d| is_iso_date(Some(d))).and_then(Value::as_str).map(str::to_string);
        sets.push("date = ?");
        vals.push(db::Bind::bind(&date));
        if let Some(d) = date {
            sets.push("day = ?");
            vals.push(db::Bind::bind(&DAYS[weekday(&d) as usize]));
        }
    }
    if body.has("ingredients") { sets.push("ingredients = ?"); vals.push(db::Bind::bind(&ingredients_column(body.raw("ingredients")))); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    try_run!(&hub.store.db(), &format!("UPDATE meals SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    let meal = db::one(&hub.store.db(), "SELECT * FROM meals WHERE id = ?", p![id]).map(|r| row_to_meal(&r)).unwrap_or(Value::Null);
    log_activity(&hub, &user, "meal.update", "meal", Some(&id), meal["name"].as_str().unwrap_or(""), json!({}));
    realtime::broadcast(&hub, &household, "meals:updated", meal.clone());
    ok(meal)
}

async fn remove_meal(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if !manages(&hub, &user, "meals") {
        return error(403, NOT_MEALS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let existing = db::one(&hub.store.db(), "SELECT name FROM meals WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(existing) = existing else { return error(404, "Meal not found.") };
    try_run!(&hub.store.db(), "DELETE FROM meals WHERE id = ? AND household_id = ?", p![id, household]);
    realtime::broadcast(&hub, &household, "meals:deleted", json!(id));
    write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&user.sub), actor_name: None, action: "meal.delete", resource_type: "meal", resource_id: Some(&id), resource_name: &db::s(&existing, "name"), metadata: json!({}) });
    no_content()
}

// ---- Notifications ----------------------------------------------------------------------------

pub fn notifications() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(my_notifications).post(add_notification).delete(dismiss_all))
        .route("/read-all", post(read_all))
        .route("/{id}", patch(edit_notification).delete(dismiss))
}

fn fetch_notification(hub: &Hub, id: &str, user_id: &str) -> Value {
    let r = db::one(&hub.store.db(),
        "SELECT n.*, COALESCE(ns.read, 0) as read_flag FROM notifications n
         LEFT JOIN notification_states ns ON ns.notification_id = n.id AND ns.user_id = ? WHERE n.id = ?", p![user_id, id]);
    r.map(|r| defined(json!({
        "id": r["id"], "householdId": r["household_id"], "memberId": db::opt(&r, "member_id"), "title": r["title"], "body": r["body"],
        "time": r["time"], "createdAt": r["created_at"], "read": db::bool(&r, "read_flag"),
    }), &["id", "householdId", "title", "body", "time", "createdAt"])).unwrap_or(Value::Null)
}

/// What a caller sees: notifications for everyone plus their own member's.
/// The wall, nobody in particular, sees only the household-wide ones.
pub fn notifications_for(hub: &Hub, user: &User) -> Vec<Value> {
    let me = if user.is_kiosk() { None } else { caller_member(hub, user).map(|m| m.id) };
    db::all(&hub.store.db(),
        "SELECT n.*, COALESCE(ns.read, 0) as read_flag FROM notifications n
         LEFT JOIN notification_states ns ON ns.notification_id = n.id AND ns.user_id = ?
         WHERE n.household_id = ? AND (n.member_id IS NULL OR n.member_id = ?) AND (ns.dismissed IS NULL OR ns.dismissed = 0)
         ORDER BY n.created_at DESC", p![user.sub.clone(), user.household_id.clone().unwrap_or_default(), me])
        .iter()
        .map(|r| defined(json!({
            "id": r["id"], "householdId": r["household_id"], "memberId": db::opt(r, "member_id"), "title": r["title"], "body": r["body"],
            "time": r["time"], "ref": db::opt(r, "ref"), "createdAt": r["created_at"], "read": db::bool(r, "read_flag"),
        }), &["id", "householdId", "title", "body", "time", "createdAt"]))
        .collect()
}

async fn my_notifications(State(hub): State<Arc<Hub>>, user: User) -> Response {
    ok(Value::Array(notifications_for(&hub, &user)))
}

async fn add_notification(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let Some(title) = body.text("title") else { return error(400, "title is required.") };
    let id = store::uuid();
    try_run!(&hub.store.db(), "INSERT INTO notifications (id, household_id, member_id, title, body, time) VALUES (?, ?, ?, ?, ?, ?)",
        p![id, household, body.get("memberId").cloned(), title, body.raw("body").cloned().unwrap_or(json!("")), body.raw("time").cloned().unwrap_or(json!(""))]);
    let n = fetch_notification(&hub, &id, &user.sub);
    realtime::broadcast(&hub, &household, "notifications:created", n.clone());
    created(n)
}

fn notification_exists(hub: &Hub, id: &str, household: &str) -> bool {
    db::one(&hub.store.db(), "SELECT id FROM notifications WHERE id = ? AND household_id = ?", p![id, household]).is_some()
}

async fn edit_notification(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !notification_exists(&hub, &id, &household) {
        return error(404, "Notification not found.");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("title") { sets.push("title = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if let Some(v) = body.raw("body") { sets.push("body = ?"); vals.push(db::Bind::bind(v)); }
    if let Some(v) = body.raw("time") { sets.push("time = ?"); vals.push(db::Bind::bind(v)); }
    if !sets.is_empty() {
        vals.extend(p![id, household]);
        try_run!(&hub.store.db(), &format!("UPDATE notifications SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    }
    if let Some(v) = body.raw("read") {
        try_run!(&hub.store.db(), "INSERT INTO notification_states (notification_id, user_id, read) VALUES (?, ?, ?)
             ON CONFLICT(notification_id, user_id) DO UPDATE SET read = excluded.read", p![id, user.sub.clone(), db::truthy(Some(v))]);
    }
    let n = fetch_notification(&hub, &id, &user.sub);
    realtime::broadcast(&hub, &household, "notifications:updated", n.clone());
    ok(n)
}

async fn dismiss(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if !notification_exists(&hub, &id, &household) {
        return error(404, "Notification not found.");
    }
    try_run!(&hub.store.db(), "INSERT INTO notification_states (notification_id, user_id, dismissed) VALUES (?, ?, 1)
         ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed = 1", p![id, user.sub.clone()]);
    realtime::broadcast(&hub, &household, "notifications:deleted", json!(id));
    no_content()
}

fn mark_all(hub: &Hub, user: &User, sql: &str) {
    let db_ = hub.store.db();
    for r in db::all(&db_, "SELECT id FROM notifications WHERE household_id = ?", p![user.household_id.clone().unwrap_or_default()]) {
        let _ = db::run(&db_, sql, p![r["id"].clone(), user.sub.clone()]);
    }
}

async fn read_all(State(hub): State<Arc<Hub>>, user: User) -> Response {
    mark_all(&hub, &user, "INSERT INTO notification_states (notification_id, user_id, read) VALUES (?, ?, 1) ON CONFLICT(notification_id, user_id) DO UPDATE SET read = 1");
    no_content()
}

async fn dismiss_all(State(hub): State<Arc<Hub>>, user: User) -> Response {
    mark_all(&hub, &user, "INSERT INTO notification_states (notification_id, user_id, dismissed) VALUES (?, ?, 1) ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed = 1");
    no_content()
}
