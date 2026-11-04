//! /api/v1/members (routes/members.ts).

use crate::auth::User;
use crate::db::{self, defined, initial, js_string, Row};
use crate::household::{caller_member, log_activity, notify_members, Note};
use crate::http::{created, error, no_content, ok, Body};
use crate::{p, try_run, realtime, relay, store, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch};
use axum::Router;
use serde_json::{json, Value};
use std::sync::Arc;

pub fn router() -> Router<Arc<Hub>> {
    Router::new().route("/", get(list).post(add)).route("/{id}", patch(edit).delete(remove))
}

pub fn row_to_member(r: &Row) -> Value {
    defined(
        json!({
            "id": r["id"], "householdId": r["household_id"], "userId": db::opt(r, "user_id"), "name": r["name"],
            "initial": r["initial"], "color": r["color"], "role": r["role"], "dob": db::opt(r, "dob"),
            "account": db::opt(r, "account"), "permissions": db::json_col(r, "permissions", json!([])),
            "pending": db::bool(r, "pending"), "createdAt": r["created_at"],
        }),
        &["householdId", "name", "initial", "color", "role", "createdAt", "permissions"],
    )
}

async fn list(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(household) = user.household() else { return ok(json!([])) };
    let rows = db::all(&hub.store.db(), "SELECT * FROM members WHERE household_id = ? ORDER BY created_at", p![household]);
    ok(Value::Array(rows.iter().map(row_to_member).collect()))
}

async fn add(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household().map(str::to_string) else { return error(403, "Device is not yet linked to a household.") };
    let Some(name) = body.text("name") else { return error(400, "name is required.") };
    let color = body.raw("color").cloned().unwrap_or(json!("blue"));
    let role = body.raw("role").cloned().unwrap_or(json!("adult"));
    let permissions = body.raw("permissions").cloned().unwrap_or(json!([]));
    let link_self = db::truthy(body.raw("linkSelf"));
    let id = store::uuid();
    let account = body.get("account").cloned().or_else(|| if link_self { user.email.clone().map(Value::String) } else { None });
    let db_ = hub.store.db();
    try_run!(
        &db_,
        "INSERT INTO members (id, household_id, user_id, name, initial, color, role, dob, account, permissions, pending)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        p![id, household, if link_self { Some(user.sub.clone()) } else { None }, name, initial(&name), color, role, body.get("dob").cloned(), account, permissions.to_string()],
    );
    let member = db::one(&db_, "SELECT * FROM members WHERE id = ?", p![id]).map(|r| row_to_member(&r)).unwrap_or(Value::Null);
    let others: Vec<String> = db::all(&db_, "SELECT id FROM members WHERE household_id = ? AND id != ?", p![household, id])
        .iter()
        .map(|r| db::s(r, "id"))
        .collect();
    drop(db_);
    log_activity(&hub, &user, "member.create", "member", Some(&id), &name, json!({}));
    realtime::broadcast(&hub, &household, "members:created", member.clone());
    // Family news: everyone else hears about the new arrival.
    let me = caller_member(&hub, &user).map(|m| m.id);
    let others: Vec<String> = others.into_iter().filter(|m| Some(m) != me.as_ref()).collect();
    if !others.is_empty() {
        let title = format!("{name} joined the family");
        let reference = format!("member:{id}");
        notify_members(&hub, &household, Some(others), Note { title: &title, body: "Say hello on Solora.", time: "", reference: Some(&reference) });
    }
    created(member)
}

async fn edit(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household().unwrap_or("").to_string();
    let db_ = hub.store.db();
    if db::one(&db_, "SELECT * FROM members WHERE id = ? AND household_id = ?", p![id, household]).is_none() {
        return error(404, "Member not found.");
    }
    let mut sets: Vec<&str> = Vec::new();
    let mut vals = Vec::new();
    if let Some(n) = body.raw("name") {
        let n = js_string(n).trim().to_string();
        sets.extend(["name = ?", "initial = ?"]);
        vals.extend(p![n.clone(), initial(&n)]);
    }
    if let Some(v) = body.raw("color") { sets.push("color = ?"); vals.push(db::Bind::bind(v)); }
    if let Some(v) = body.raw("role") { sets.push("role = ?"); vals.push(db::Bind::bind(v)); }
    if body.has("dob") { sets.push("dob = ?"); vals.push(db::Bind::bind(&body.get("dob").cloned())); }
    if body.has("account") { sets.push("account = ?"); vals.push(db::Bind::bind(&body.get("account").cloned())); }
    if let Some(v) = body.raw("permissions") { sets.push("permissions = ?"); vals.push(db::Bind::bind(&v.to_string())); }
    if let Some(v) = body.raw("pending") { sets.push("pending = ?"); vals.push(db::Bind::bind(&(db::truthy(Some(v)) as i64))); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    try_run!(&db_, &format!("UPDATE members SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    let member = db::one(&db_, "SELECT * FROM members WHERE id = ?", p![id]).map(|r| row_to_member(&r)).unwrap_or(Value::Null);
    drop(db_);
    log_activity(&hub, &user, "member.update", "member", Some(&id), member["name"].as_str().unwrap_or(""), json!({}));
    realtime::broadcast(&hub, &household, "members:updated", member.clone());
    ok(member)
}

async fn remove(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household().unwrap_or("").to_string();
    let mut db_ = hub.store.db();
    let Some(existing) = db::one(&db_, "SELECT id, name, user_id FROM members WHERE id = ? AND household_id = ?", p![id, household]) else {
        return error(404, "Member not found.");
    };
    let invites = db::all(&db_, "SELECT code, token FROM invites WHERE member_id = ?", p![id]);
    if let Ok(tx) = db_.transaction() {
        try_run!(&tx, "DELETE FROM invites WHERE member_id = ?", p![id]);
        try_run!(&tx, "DELETE FROM members WHERE id = ? AND household_id = ?", p![id, household]);
        // A kid's phone has no account to keep; its local user goes with the member.
        if let Some(u) = db::text(&existing, "user_id") {
            try_run!(&tx, "DELETE FROM users WHERE id = ? AND device_only = 1", p![u]);
        }
        let _ = tx.commit();
    }
    drop(db_);
    for i in &invites {
        relay::unregister_remote_invite(&hub, &db::s(i, "code"), &db::s(i, "token"));
    }
    log_activity(&hub, &user, "member.delete", "member", Some(&id), &db::s(&existing, "name"), json!({}));
    realtime::broadcast(&hub, &household, "members:deleted", json!(id));
    no_content()
}
