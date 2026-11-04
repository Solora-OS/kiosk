//! /api/v1/chores and /api/v1/rewards (routes/chores.ts, routes/rewards.ts)
//! and points (services/points.ts): what chores earn and rewards cost.

use crate::auth::User;
use crate::db::{self, defined, js_string, Row};
use crate::hometime::{add_days_iso, home_today, weekday};
use crate::household::{caller_member, log_activity, manages, notify_members, write_log, LogEntry, Note};
use crate::http::{created, error, no_content, ok, Body};
use crate::routes::calendar::{js_number, parse_repeat_days, repeat_days_column};
use crate::{p, try_run, realtime, store, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::Router;
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

// ---- Chores ------------------------------------------------------------------------------

pub fn chores() -> Router<Arc<Hub>> {
    Router::new().route("/", get(list_chores).post(add_chore)).route("/{id}", patch(edit_chore).delete(remove_chore))
}

/// A picture key: short lowercase id, or null to clear it.
fn icon_column(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| (1..=32).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')).map(str::to_string)
}

const SUMMER_MODES: [&str; 4] = ["same", "off", "only", "days"];
fn summer_mode(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).filter(|m| SUMMER_MODES.contains(m)).unwrap_or("same").to_string()
}

pub fn row_to_chore(hub: &Hub, r: &Row) -> Value {
    let repeat_days = parse_repeat_days(&db::opt(r, "repeat_days"));
    let done_on = db::text(r, "done_on");
    let done = if repeat_days.is_some() { done_on.as_deref() == Some(home_today(hub).as_str()) } else { db::bool(r, "done") };
    defined(
        json!({
            "id": r["id"], "householdId": r["household_id"], "memberId": db::opt(r, "member_id"), "title": r["title"], "done": done,
            "points": r["points"], "due": r["due"], "repeatDays": repeat_days.map(|d| json!(d)).unwrap_or(Value::Null),
            "doneOn": done_on, "icon": db::opt(r, "icon"), "keepWhileAway": db::bool(r, "keep_while_away"),
            "summerMode": summer_mode(r.get("summer_mode")), "summerDays": parse_repeat_days(&db::opt(r, "summer_days")).unwrap_or_default(),
            "createdAt": r["created_at"],
        }),
        &["id", "householdId", "title", "points", "due", "createdAt"],
    )
}

/// The person it's for, a parent with chore permissions, an admin, or the wall.
fn can_complete(hub: &Hub, user: &User, member_id: Option<&str>) -> bool {
    manages(hub, user, "chores") || caller_member(hub, user).is_some_and(|m| Some(m.id.as_str()) == member_id)
}

async fn list_chores(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM chores WHERE household_id = ? ORDER BY created_at", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(|r| row_to_chore(&hub, r)).collect()))
}

async fn add_chore(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let Some(title) = body.text("title") else { return error(400, "title is required.") };
    let done = db::truthy(body.raw("done"));
    let today = home_today(&hub);
    let id = store::uuid();
    let db_ = hub.store.db();
    try_run!(
        &db_,
        "INSERT INTO chores (id, household_id, member_id, title, done, points, due, repeat_days, done_on, icon, keep_while_away, summer_mode, summer_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        p![
            id, household, body.get("memberId").cloned(), title, done, body.raw("points").cloned().unwrap_or(json!(0)), body.raw("due").cloned().unwrap_or(json!("")),
            repeat_days_column(body.raw("repeatDays")), if done { Some(today) } else { None }, icon_column(body.raw("icon")),
            db::truthy(body.raw("keepWhileAway")), summer_mode(body.raw("summerMode")), repeat_days_column(body.raw("summerDays")),
        ],
    );
    let row = db::one(&db_, "SELECT * FROM chores WHERE id = ?", p![id]);
    drop(db_);
    let chore = row.map(|r| row_to_chore(&hub, &r)).unwrap_or(Value::Null);
    log_activity(&hub, &user, "chore.create", "chore", Some(&id), &title, json!({}));
    realtime::broadcast(&hub, &household, "chores:created", chore.clone());
    created(chore)
}

async fn edit_chore(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let current = db::one(&hub.store.db(), "SELECT * FROM chores WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(current) = current else { return error(404, "Chore not found.") };
    let done_given = body.raw("done");
    if done_given.is_some() && !can_complete(&hub, &user, db::text(&current, "member_id").as_deref()) {
        return error(403, "Only the person this chore is for, or a parent, can check it off.");
    }
    let today = home_today(&hub);
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("title") { sets.push("title = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if body.has("memberId") { sets.push("member_id = ?"); vals.push(db::Bind::bind(&body.get("memberId").cloned())); }
    if let Some(v) = done_given {
        let d = db::truthy(Some(v));
        sets.extend(["done = ?", "done_on = ?"]);
        vals.extend(p![d, if d { Some(today.clone()) } else { None }]);
    }
    if let Some(v) = body.raw("points") { sets.push("points = ?"); vals.push(db::Bind::bind(v)); }
    if let Some(v) = body.raw("due") { sets.push("due = ?"); vals.push(db::Bind::bind(v)); }
    if body.has("repeatDays") { sets.push("repeat_days = ?"); vals.push(db::Bind::bind(&repeat_days_column(body.raw("repeatDays")))); }
    if body.has("icon") { sets.push("icon = ?"); vals.push(db::Bind::bind(&icon_column(body.raw("icon")))); }
    if let Some(v) = body.raw("keepWhileAway") { sets.push("keep_while_away = ?"); vals.push(db::Bind::bind(&db::truthy(Some(v)))); }
    if let Some(v) = body.raw("summerMode") { sets.push("summer_mode = ?"); vals.push(db::Bind::bind(&summer_mode(Some(v)))); }
    if body.has("summerDays") { sets.push("summer_days = ?"); vals.push(db::Bind::bind(&repeat_days_column(body.raw("summerDays")))); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    let before = row_to_chore(&hub, &current);
    let was_done = before["done"].as_bool().unwrap_or(false);
    let toggled = done_given.is_some_and(|v| db::truthy(Some(v)) != was_done);
    {
        let mut db_ = hub.store.db();
        if let Ok(tx) = db_.transaction() {
            try_run!(&tx, &format!("UPDATE chores SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
            if toggled {
                record_completion(&tx, &household, &id, before["title"].as_str().unwrap_or(""), &before["points"], before.get("memberId").and_then(Value::as_str), db::truthy(done_given), &today);
            }
            let _ = tx.commit();
        };
    }
    let row = db::one(&hub.store.db(), "SELECT * FROM chores WHERE id = ?", p![id]);
    let chore = row.map(|r| row_to_chore(&hub, &r)).unwrap_or(Value::Null);
    let only_done = body.0.as_object().is_some_and(|o| o.keys().all(|k| k == "done"));
    if toggled || !only_done {
        let action = if toggled { if db::truthy(done_given) { "chore.complete" } else { "chore.uncomplete" } } else { "chore.update" };
        log_activity(&hub, &user, action, "chore", Some(&id), chore["title"].as_str().unwrap_or(""), json!({}));
    }
    realtime::broadcast(&hub, &household, "chores:updated", chore.clone());
    ok(chore)
}

async fn remove_chore(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let gone = db::one(&hub.store.db(), "SELECT title FROM chores WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(gone) = gone else { return error(404, "Chore not found.") };
    try_run!(&hub.store.db(), "DELETE FROM chores WHERE id = ? AND household_id = ?", p![id, household]);
    log_activity(&hub, &user, "chore.delete", "chore", Some(&id), &db::s(&gone, "title"), json!({}));
    realtime::broadcast(&hub, &household, "chores:deleted", json!(id));
    no_content()
}

// ---- Points --------------------------------------------------------------------------------

/// A chore checked off (done) or unticked, for the member it's assigned to.
fn record_completion(db_: &Connection, household: &str, chore_id: &str, title: &str, points: &Value, member_id: Option<&str>, done: bool, date: &str) {
    if done {
        let Some(member) = member_id else { return };
        let _ = db::run(db_, "INSERT INTO chore_completions (id, household_id, chore_id, member_id, title, points, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
            p![store::uuid(), household, chore_id, member, title, points, date]);
    } else {
        let _ = db::run(db_, "DELETE FROM chore_completions WHERE id = (
             SELECT id FROM chore_completions WHERE household_id = ? AND chore_id = ? ORDER BY created_at DESC LIMIT 1)", p![household, chore_id]);
    }
}

fn sum(db_: &Connection, sql: &str, params: Vec<rusqlite::types::Value>) -> f64 {
    db::one(db_, sql, params).map(|r| db::number(&r, "n")).unwrap_or(0.0)
}

/// Every member's balance (earned minus requested or approved spending), what
/// they earned today and this week (from Monday), and their streak: days in a
/// row up to today (or yesterday) with a chore done, where away days don't break it.
pub fn member_points(hub: &Hub, household: &str, today: &str) -> Vec<Value> {
    let db_ = hub.store.db();
    let away = db::one(&db_, "SELECT away_from, away_until FROM households WHERE id = ?", p![household]);
    let (away_from, away_until) = away.map(|a| (db::text(&a, "away_from"), db::text(&a, "away_until"))).unwrap_or((None, None));
    let was_away = |day: &str| matches!((&away_from, &away_until), (Some(f), Some(u)) if day >= f.as_str() && day <= u.as_str());
    let week_start = add_days_iso(today, -(((weekday(today) + 6) % 7) as i64));
    db::all(&db_, "SELECT id FROM members WHERE household_id = ?", p![household])
        .iter()
        .map(|m| {
            let id = db::s(m, "id");
            let earned = sum(&db_, "SELECT COALESCE(SUM(points), 0) AS n FROM chore_completions WHERE household_id = ? AND member_id = ?", p![household, id]);
            let spent = sum(&db_, "SELECT COALESCE(SUM(cost), 0) AS n FROM redemptions WHERE household_id = ? AND member_id = ? AND status != 'declined'", p![household, id]);
            let since = |from: &str| sum(&db_, "SELECT COALESCE(SUM(points), 0) AS n FROM chore_completions WHERE household_id = ? AND member_id = ? AND date >= ? AND date <= ?", p![household, id, from, today]);
            let days: HashSet<String> = db::all(&db_, "SELECT DISTINCT date FROM chore_completions WHERE household_id = ? AND member_id = ? AND date <= ? ORDER BY date DESC LIMIT 400", p![household, id, today])
                .iter()
                .map(|r| db::s(r, "date"))
                .collect();
            let mut day = if days.contains(today) { today.to_string() } else { add_days_iso(today, -1) };
            let mut streak = 0;
            for _ in 0..800 {
                if !(days.contains(&day) || was_away(&day)) {
                    break;
                }
                if days.contains(&day) {
                    streak += 1;
                }
                day = add_days_iso(&day, -1);
            }
            json!({ "memberId": id, "balance": db::num(earned - spent), "earnedToday": db::num(since(today)), "earnedThisWeek": db::num(since(&week_start)), "streak": streak })
        })
        .collect()
}

/// Members who run chores and rewards: admins and anyone with the Chores permission.
fn chore_managers(hub: &Hub, household: &str) -> Vec<String> {
    db::all(&hub.store.db(), "SELECT id, role, permissions FROM members WHERE household_id = ?", p![household])
        .iter()
        .filter(|m| db::s(m, "role") == "admin" || db::s(m, "permissions").contains("\"chores\""))
        .map(|m| db::s(m, "id"))
        .collect()
}

// ---- Rewards --------------------------------------------------------------------------------

pub fn rewards() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(shelf).post(add_reward))
        .route("/{id}", patch(edit_reward).delete(remove_reward))
        .route("/{id}/redeem", post(redeem))
        .route("/redemptions/{id}/approve", post(approve))
        .route("/redemptions/{id}/decline", post(decline))
}

fn to_reward(r: &Row) -> Value {
    defined(json!({ "id": r["id"], "title": r["title"], "cost": r["cost"], "icon": db::opt(r, "icon") }), &["id", "title", "cost"])
}

fn to_redemption(r: &Row) -> Value {
    defined(
        json!({ "id": r["id"], "rewardId": db::opt(r, "reward_id"), "memberId": r["member_id"], "title": r["title"], "cost": r["cost"], "status": r["status"], "createdAt": r["created_at"] }),
        &["id", "memberId", "title", "cost", "status", "createdAt"],
    )
}

/// A parent on their own device: the only one who can approve spending (the shared wall can't).
fn is_parent(hub: &Hub, user: &User) -> bool {
    !user.is_kiosk() && manages(hub, user, "chores")
}

async fn shelf(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let today = home_today(&hub);
    let rewards: Vec<Value> = db::all(&hub.store.db(), "SELECT * FROM rewards WHERE household_id = ? ORDER BY cost", p![household]).iter().map(to_reward).collect();
    let points = member_points(&hub, &household, &today);
    let redemptions: Vec<Value> = db::all(&hub.store.db(), "SELECT * FROM redemptions WHERE household_id = ? ORDER BY created_at DESC LIMIT 30", p![household]).iter().map(to_redemption).collect();
    ok(json!({ "rewards": rewards, "points": points, "redemptions": redemptions }))
}

/// readReward: the fields, or the message to show.
fn read_reward(title: Option<&Value>, cost: Option<&Value>, icon: Option<&Value>) -> Result<(String, i64, Option<String>), &'static str> {
    let title = title.and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    let cost = js_number(cost);
    if title.is_empty() {
        return Err("Give the reward a name.");
    }
    if cost.fract() != 0.0 || !(1.0..=100_000.0).contains(&cost) {
        return Err("Cost must be a whole number of points.");
    }
    Ok((title, cost as i64, icon_column(icon)))
}

async fn add_reward(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if !manages(&hub, &user, "chores") {
        return error(403, "Only a parent can add rewards.");
    }
    let (title, cost, icon) = match read_reward(body.raw("title"), body.raw("cost"), body.raw("icon")) {
        Ok(r) => r,
        Err(m) => return error(400, m),
    };
    let id = store::uuid();
    try_run!(&hub.store.db(), "INSERT INTO rewards (id, household_id, title, cost, icon) VALUES (?, ?, ?, ?, ?)", p![id, user.household_id.clone(), title, cost, icon]);
    log_activity(&hub, &user, "reward.create", "reward", Some(&id), &title, json!({ "cost": cost }));
    created(defined(json!({ "id": id, "title": title, "cost": cost, "icon": icon }), &[]))
}

async fn edit_reward(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if !manages(&hub, &user, "chores") {
        return error(403, "Only a parent can change rewards.");
    }
    let existing = db::one(&hub.store.db(), "SELECT * FROM rewards WHERE id = ? AND household_id = ?", p![id, user.household_id.clone()]);
    let Some(existing) = existing else { return error(404, "Reward not found.") };
    // { ...existing, ...body }: body fields win, even when null.
    let field = |k: &str| body.raw(k).or(existing.get(k));
    let (title, cost, icon) = match read_reward(field("title"), field("cost"), field("icon")) {
        Ok(r) => r,
        Err(m) => return error(400, m),
    };
    try_run!(&hub.store.db(), "UPDATE rewards SET title = ?, cost = ?, icon = ? WHERE id = ?", p![title, cost, icon, id]);
    ok(defined(json!({ "id": id, "title": title, "cost": cost, "icon": icon }), &[]))
}

async fn remove_reward(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if !manages(&hub, &user, "chores") {
        return error(403, "Only a parent can remove rewards.");
    }
    let gone = db::one(&hub.store.db(), "SELECT title FROM rewards WHERE id = ? AND household_id = ?", p![id, user.household_id.clone()]);
    try_run!(&hub.store.db(), "DELETE FROM rewards WHERE id = ? AND household_id = ?", p![id, user.household_id.clone()]);
    if let Some(g) = gone {
        log_activity(&hub, &user, "reward.delete", "reward", Some(&id), &db::s(&g, "title"), json!({}));
    }
    no_content()
}

async fn redeem(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let reward = db::one(&hub.store.db(), "SELECT * FROM rewards WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(reward) = reward else { return error(404, "Reward not found.") };
    let me = caller_member(&hub, &user).map(|m| m.id);
    let asked = body.get("memberId").map(db::js_string).filter(|s| !s.is_empty());
    let member_id = if manages(&hub, &user, "chores") { asked.clone().or(me.clone()) } else { me.clone() };
    let Some(member_id) = member_id.filter(|m| asked.as_ref().is_none_or(|a| a == m)) else { return error(403, "You can only spend your own points.") };
    if db::one(&hub.store.db(), "SELECT 1 FROM members WHERE id = ? AND household_id = ?", p![member_id, household]).is_none() {
        return error(404, "Member not found.");
    }
    let balance = member_points(&hub, &household, &home_today(&hub)).into_iter().find(|p| p["memberId"] == json!(member_id)).and_then(|p| p["balance"].as_f64()).unwrap_or(0.0);
    let cost = db::number(&reward, "cost");
    if balance < cost {
        return error(409, format!("Not enough points yet: {} of {}.", db::num(balance), db::num(cost)));
    }
    let rid = store::uuid();
    let status = if is_parent(&hub, &user) { "approved" } else { "requested" };
    let db_ = hub.store.db();
    try_run!(&db_, "INSERT INTO redemptions (id, household_id, reward_id, member_id, title, cost, status, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        p![rid, household, reward["id"].clone(), member_id, reward["title"].clone(), reward["cost"].clone(), status, if status == "approved" { Some(store::now_iso()) } else { None }]);
    let r = db::one(&db_, "SELECT * FROM redemptions WHERE id = ?", p![rid]).map(|r| to_redemption(&r)).unwrap_or(Value::Null);
    let who = db::one(&db_, "SELECT name FROM members WHERE id = ?", p![member_id]).map(|m| db::s(&m, "name")).unwrap_or_else(|| "Someone".into());
    drop(db_);
    let title = r["title"].as_str().unwrap_or("").to_string();
    if status == "requested" {
        let managers: Vec<String> = chore_managers(&hub, &household).into_iter().filter(|m| m != &member_id).collect();
        let (t, b, reference) = (format!("{who} wants {title}"), format!("{} points · approve it on the rewards shelf", r["cost"]), format!("redemption:{rid}"));
        notify_members(&hub, &household, Some(managers), Note { title: &t, body: &b, time: "", reference: Some(&reference) });
    }
    write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&member_id), actor_name: None, action: "reward.redeem", resource_type: "reward", resource_id: Some(&rid), resource_name: &title, metadata: json!({ "cost": r["cost"] }) });
    created(r)
}

async fn decide(hub: Arc<Hub>, user: User, id: String, status: &'static str) -> Response {
    if !is_parent(&hub, &user) {
        return error(403, "A parent approves rewards on their own phone.");
    }
    let household = user.household_id.clone().unwrap_or_default();
    let changed = db::run(&hub.store.db(), "UPDATE redemptions SET status = ?, decided_at = ? WHERE id = ? AND household_id = ? AND status = 'requested'", p![status, store::now_iso(), id, household]).unwrap_or(0);
    if changed == 0 {
        return error(404, "That request was already handled.");
    }
    let r = db::one(&hub.store.db(), "SELECT * FROM redemptions WHERE id = ?", p![id]).map(|r| to_redemption(&r)).unwrap_or(Value::Null);
    let member = r["memberId"].as_str().unwrap_or("").to_string();
    let for_name = db::one(&hub.store.db(), "SELECT name FROM members WHERE id = ?", p![member]).map(|m| db::s(&m, "name")).unwrap_or_default();
    let title = r["title"].as_str().unwrap_or("").to_string();
    log_activity(&hub, &user, if status == "approved" { "reward.approve" } else { "reward.decline" }, "reward", Some(&id), &title, json!({ "for": for_name }));
    let reference = format!("redemption:{id}");
    let (t, b) = if status == "approved" {
        (format!("{title}: yes!"), format!("{} points spent. Enjoy.", r["cost"]))
    } else {
        (format!("{title}: not this time"), format!("Your {} points are back.", r["cost"]))
    };
    notify_members(&hub, &household, Some(vec![member]), Note { title: &t, body: &b, time: "", reference: Some(&reference) });
    ok(r)
}

async fn approve(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    decide(hub, user, id, "approved").await
}
async fn decline(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    decide(hub, user, id, "declined").await
}
