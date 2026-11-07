//! /api/v1/invites (routes/invites.ts): invites, tap-to-invite tickets, and
//! joining with an account or as a device-only (kid's) phone.

use crate::auth::User;
use crate::db::{self, defined, initial, Row};
use crate::household::{log_activity, write_log, LogEntry};
use crate::http::{created, error, lan_base_url, no_content, ok, Body};
use crate::routes::auth::{central_hub_id, remote_key};
use crate::{p, try_run, relay, store, tokens, Hub};
use axum::extract::{Path, State};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", post(create))
        .route("/{id}/tap", post(tap))
        .route("/{id}/tap/{ticket}", get(tap_poll))
        .route("/{id}/tap/{ticket}/{decision}", post(tap_decide))
        .route("/claim", post(claim).get(lookup_claim))
        .route("/claim-device", post(claim_device).get(lookup_claim_device))
        .route("/{key}", get(lookup).delete(cancel))
}

fn invite_code() -> String {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut bytes = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut bytes);
    let code: String = bytes.iter().map(|b| CHARS[*b as usize % CHARS.len()] as char).collect();
    format!("{}-{}", &code[..3], &code[3..])
}

fn row_to_invite(r: &Row) -> Value {
    defined(
        json!({
            "id": r["id"], "householdId": r["household_id"], "memberId": r["member_id"], "token": r["token"], "code": r["code"],
            "name": r["name"], "role": r["role"], "color": r["color"], "dob": db::opt(r, "dob"), "email": db::opt(r, "email"),
            "expiresAt": r["expires_at"], "createdAt": r["created_at"],
        }),
        &["id", "householdId", "memberId", "token", "code", "name", "role", "color", "expiresAt", "createdAt"],
    )
}

fn iso_in(ms: u64) -> String {
    let t: chrono::DateTime<chrono::Utc> = (SystemTime::now() + Duration::from_millis(ms)).into();
    t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn expired(r: &Row) -> bool {
    chrono::DateTime::parse_from_rfc3339(&db::s(r, "expires_at")).map(|t| t < chrono::Utc::now()).unwrap_or(false)
}

async fn create(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let Some(name) = body.text("name") else { return error(400, "name is required.") };
    let role = body.raw("role").cloned().unwrap_or(json!("adult"));
    let color = body.raw("color").cloned().unwrap_or(json!("blue"));
    let email = body.get("email").cloned();
    let dob = body.get("dob").cloned();
    // The kiosk has sent snake_case; reading only memberId made a second, pending copy.
    let member_id = body.get("memberId").or(body.get("member_id")).map(db::js_string);
    let db_ = hub.store.db();
    let final_member = match member_id {
        Some(mid) => {
            if db::one(&db_, "SELECT 1 FROM members WHERE id = ? AND household_id = ?", p![mid, household]).is_none() {
                return error(404, "That member no longer exists.");
            }
            if db::truthy(email.as_ref()) {
                try_run!(&db_, "UPDATE members SET pending = 1, account = ? WHERE id = ? AND household_id = ?", p![email, mid, household]);
            } else {
                try_run!(&db_, "UPDATE members SET pending = 1 WHERE id = ? AND household_id = ?", p![mid, household]);
            }
            mid
        }
        None => {
            let mid = store::uuid();
            try_run!(
                &db_,
                "INSERT INTO members (id, household_id, name, initial, color, role, dob, account, permissions, pending)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 1)",
                p![mid, household, name, initial(&name), color, role, dob, email],
            );
            mid
        }
    };
    // Drop the member's stale invite.
    let stale = db::all(&db_, "SELECT code, token FROM invites WHERE member_id = ?", p![final_member]);
    try_run!(&db_, "DELETE FROM invites WHERE member_id = ?", p![final_member]);
    let id = store::uuid();
    let token = format!("inv_{}", store::uuid().replace('-', ""));
    let code = invite_code();
    let expires_at = iso_in(7 * 24 * 3600 * 1000);
    try_run!(
        &db_,
        "INSERT INTO invites (id, household_id, member_id, token, code, name, role, color, dob, email, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        p![id, household, final_member, token, code, name, role, color, dob, email, expires_at],
    );
    let row = db::one(&db_, "SELECT * FROM invites WHERE id = ?", p![id]).unwrap_or_default();
    drop(db_);
    for s in &stale {
        relay::unregister_remote_invite(&hub, &db::s(s, "code"), &db::s(s, "token"));
    }
    relay::register_remote_invite(&hub, &code, &token, &expires_at);
    log_activity(&hub, &user, "member.invite", "member", Some(&final_member), &name, json!({}));
    created(row_to_invite(&row))
}

// ---- Tap to invite -------------------------------------------------------------------
// Bluetooth hands over a short-lived ticket, never the invite. It only turns
// into the invite once the inviting phone approves, after the person checks
// the 4-digit number the new phone shows.

#[derive(Clone)]
struct Ticket {
    invite_id: String,
    household_id: String,
    expires_at: Instant,
    state: &'static str,
    check: Option<String>,
}

fn tickets() -> &'static Mutex<HashMap<String, Ticket>> {
    static T: std::sync::OnceLock<Mutex<HashMap<String, Ticket>>> = std::sync::OnceLock::new();
    T.get_or_init(Default::default)
}

const TAP_TTL: Duration = Duration::from_secs(3 * 60);
/// Time the new phone has to finish its profile once approved.
const TAP_CLAIM: Duration = Duration::from_secs(15 * 60);

fn live_ticket(hub: &Arc<Hub>, id: &str) -> Option<Ticket> {
    let mut map = tickets().lock().unwrap();
    let t = map.get(id)?.clone();
    if t.expires_at < Instant::now() {
        map.remove(id);
        relay::unregister_remote_invite(hub, id, id);
        return None;
    }
    Some(t)
}

async fn tap(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if db::one(&hub.store.db(), "SELECT id FROM invites WHERE id = ? AND household_id = ?", p![id, household]).is_none() {
        return error(404, "Invite not found.");
    }
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let ticket = format!("tap_{}", hex::encode(bytes));
    let expires = iso_in(TAP_TTL.as_millis() as u64);
    tickets().lock().unwrap().insert(ticket.clone(), Ticket { invite_id: id, household_id: household, expires_at: Instant::now() + TAP_TTL, state: "open", check: None });
    // So a phone that isn't on this Wi-Fi can still answer through central.
    relay::register_remote_invite(&hub, &ticket, &ticket, &expires);
    created(json!({ "ticket": ticket, "expiresAt": expires }))
}

async fn tap_poll(State(hub): State<Arc<Hub>>, user: User, Path((id, ticket)): Path<(String, String)>) -> Response {
    match live_ticket(&hub, &ticket) {
        Some(t) if t.invite_id == id && Some(&t.household_id) == user.household_id.as_ref() => ok(json!({ "state": t.state, "check": t.check })),
        _ => error(404, "This tap invite timed out."),
    }
}

async fn tap_decide(State(hub): State<Arc<Hub>>, user: User, Path((id, ticket, decision)): Path<(String, String, String)>) -> Response {
    if decision != "approve" && decision != "deny" {
        return error(404, "Not found.");
    }
    let t = match live_ticket(&hub, &ticket) {
        Some(t) if t.invite_id == id && Some(&t.household_id) == user.household_id.as_ref() => t,
        _ => return error(404, "This tap invite timed out."),
    };
    if t.state != "requested" {
        return error(409, "No phone is waiting on this invite.");
    }
    let mut map = tickets().lock().unwrap();
    let Some(t) = map.get_mut(&ticket) else { return error(404, "This tap invite timed out.") };
    if decision == "approve" {
        t.state = "approved";
        t.expires_at = Instant::now() + TAP_CLAIM;
    } else {
        t.state = "denied";
    }
    ok(json!({ "state": t.state }))
}

/// A new phone asking with "tap_<ticket>.<4 digits>": the invite once approved.
fn tap_lookup(hub: &Arc<Hub>, key: &str) -> Result<Row, Response> {
    let lower = key.to_lowercase();
    let mut parts = lower.splitn(2, '.');
    let ticket_id = parts.next().unwrap_or("").to_string();
    let check = parts.next().unwrap_or("").to_string();
    let t = match live_ticket(hub, &ticket_id) {
        Some(t) if t.state != "denied" => t,
        _ => return Err(error(404, "This tap invite was cancelled or timed out. Ask them to tap again.")),
    };
    if !(check.len() == 4 && check.bytes().all(|b| b.is_ascii_digit())) {
        return Err(error(400, "Missing check number."));
    }
    let mut state = t.state;
    let mut held = t.check.clone();
    if state == "open" {
        let mut map = tickets().lock().unwrap();
        if let Some(t) = map.get_mut(&ticket_id) {
            t.state = "requested";
            t.check = Some(check.clone());
        }
        state = "requested";
        held = Some(check.clone());
    }
    if held.as_deref() != Some(check.as_str()) {
        return Err(error(409, "Another phone answered this invite first. Ask them to tap again."));
    }
    if state != "approved" {
        return Err((axum::http::StatusCode::ACCEPTED, axum::Json(json!({ "pending": true, "check": check }))).into_response());
    }
    db::one(&hub.store.db(), "SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.id = ?", p![t.invite_id])
        .ok_or_else(|| error(404, "Invite not found or already used."))
}

async fn lookup_key(hub: Arc<Hub>, key: String) -> Response {
    let key = key.trim().to_string();
    let row = if key.to_ascii_lowercase().starts_with("tap_") {
        match tap_lookup(&hub, &key) {
            Ok(r) => Some(r),
            Err(res) => return res,
        }
    } else {
        let db_ = hub.store.db();
        db::one(&db_, "SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.token = ?", p![key]).or_else(|| {
            db::one(&db_, "SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE UPPER(i.code) = UPPER(?)", p![key])
        })
    };
    let Some(row) = row else { return error(404, "Invite not found or expired.") };
    if expired(&row) {
        return error(410, "This invite has expired.");
    }
    let mut out = row_to_invite(&row);
    out["householdName"] = row["household_name"].clone();
    out["memberName"] = row["name"].clone();
    ok(out)
}

async fn lookup(State(hub): State<Arc<Hub>>, Path(key): Path<String>) -> Response {
    lookup_key(hub, key).await
}
async fn lookup_claim(State(hub): State<Arc<Hub>>) -> Response {
    lookup_key(hub, "claim".into()).await
}
async fn lookup_claim_device(State(hub): State<Arc<Hub>>) -> Response {
    lookup_key(hub, "claim-device".into()).await
}

fn household_of(hub: &Hub, id: &str) -> Value {
    db::one(&hub.store.db(), "SELECT id, name FROM households WHERE id = ?", p![id]).map(Value::Object).unwrap_or(Value::Null)
}

async fn claim(State(hub): State<Arc<Hub>>, body: Body) -> Response {
    let (token, access_token, name) = (body.str("token").filter(|s| !s.is_empty()), body.str("access_token").filter(|s| !s.is_empty()), body.text("name"));
    let (Some(token), Some(access_token), Some(name)) = (token, access_token, name) else {
        return error(400, "token, access_token and name are required.");
    };
    let Some(account) = hub.keys.verify(access_token).await else { return error(401, "Invalid or expired token. Sign in again.") };
    let mut db_ = hub.store.db();
    let Some(invite) = db::one(&db_, "SELECT * FROM invites WHERE token = ?", p![token]) else { return error(404, "Invite not found or already used.") };
    if expired(&invite) {
        return error(410, "This invite has expired.");
    }
    let email = account.email.to_lowercase();
    let household_id = db::s(&invite, "household_id");
    let reusable = db::number(&invite, "reusable") == 1.0;
    // A standing code belongs to whoever claimed it first.
    if reusable {
        let holder = db::one(&db_, "SELECT u.account_id FROM members m JOIN users u ON u.id = m.user_id WHERE m.id = ?", p![invite["member_id"].clone()]);
        if holder.is_some_and(|h| db::text(&h, "account_id").as_deref() != Some(account.sub.as_str())) {
            return error(409, "This code belongs to another account.");
        }
    }
    let by_account = db::one(&db_, "SELECT id, household_id FROM users WHERE account_id = ?", p![account.sub]);
    // A user from before central (a hub password) is upgraded in place.
    let legacy = if by_account.is_none() { db::one(&db_, "SELECT id, household_id FROM users WHERE email = ? AND account_id IS NULL", p![email]) } else { None };
    let existing = by_account.clone().or(legacy.clone());
    if existing.as_ref().is_some_and(|e| db::s(e, "household_id") != household_id) {
        return error(409, "This account is already linked to a different household.");
    }
    let user_id = existing.as_ref().map(|e| db::s(e, "id")).unwrap_or_else(store::uuid);
    if let Ok(tx) = db_.transaction() {
        if let Some(l) = &legacy {
            try_run!(&tx, "UPDATE users SET account_id = ?, password_hash = NULL WHERE id = ?", p![account.sub, db::s(l, "id")]);
        } else if by_account.is_none() {
            try_run!(&tx, "INSERT INTO users (id, household_id, email, name, account_id) VALUES (?, ?, ?, ?, ?)", p![user_id, household_id, email, name, account.sub]);
        }
        try_run!(
            &tx,
            "UPDATE members SET user_id = ?, name = ?, initial = ?, dob = ?, color = ?, account = ?, pending = 0 WHERE id = ?",
            p![user_id, name, initial(&name), body.get("dob").cloned(), body.get("color").cloned().unwrap_or(invite["color"].clone()), email, invite["member_id"].clone()],
        );
        if !reusable {
            try_run!(&tx, "DELETE FROM invites WHERE id = ?", p![invite["id"].clone()]);
        }
        let _ = tx.commit();
    }
    drop(db_);
    if !reusable {
        relay::unregister_remote_invite(&hub, &db::s(&invite, "code"), &db::s(&invite, "token"));
    }
    let member_id = db::s(&invite, "member_id");
    // Nobody is signed in yet: the person joining is the one who did it.
    write_log(&hub, LogEntry { household_id: &household_id, actor_id: Some(&member_id), actor_name: None, action: "member.join", resource_type: "member", resource_id: Some(&member_id), resource_name: &name, metadata: json!({}) });
    created(json!({
        "user": { "id": user_id, "email": email, "name": name },
        "household": household_of(&hub, &household_id),
        "remoteKey": hex::encode(remote_key(&hub)),
        "hubId": central_hub_id(&hub),
        "lanUrl": lan_base_url(hub.config.port),
    }))
}

async fn claim_device(State(hub): State<Arc<Hub>>, body: Body) -> Response {
    let (Some(token), Some(name)) = (body.str("token").filter(|s| !s.is_empty()), body.text("name")) else {
        return error(400, "token and name are required.");
    };
    let mut db_ = hub.store.db();
    let Some(invite) = db::one(&db_, "SELECT * FROM invites WHERE token = ?", p![token]) else { return error(404, "Invite not found or already used.") };
    if expired(&invite) {
        return error(410, "This invite has expired.");
    }
    let role = db::s(&invite, "role");
    if role != "child" && role != "teen" {
        return error(403, "Adults join with an email address.");
    }
    let household_id = db::s(&invite, "household_id");
    let member_id = db::s(&invite, "member_id");
    let user_id = store::uuid();
    // email is UNIQUE NOT NULL; a reserved .invalid address is never a real inbox.
    let placeholder = format!("member-{user_id}@device.invalid");
    if let Ok(tx) = db_.transaction() {
        try_run!(&tx, "INSERT INTO users (id, household_id, email, name, device_only) VALUES (?, ?, ?, ?, 1)", p![user_id, household_id, placeholder, name]);
        try_run!(
            &tx,
            "UPDATE members SET user_id = ?, name = ?, initial = ?, dob = ?, color = ?, account = NULL, pending = 0 WHERE id = ?",
            p![user_id, name, initial(&name), body.get("dob").cloned(), body.get("color").cloned().unwrap_or(invite["color"].clone()), member_id],
        );
        try_run!(&tx, "DELETE FROM invites WHERE id = ?", p![invite["id"].clone()]);
        let _ = tx.commit();
    }
    drop(db_);
    relay::unregister_remote_invite(&hub, &db::s(&invite, "code"), &db::s(&invite, "token"));
    write_log(&hub, LogEntry { household_id: &household_id, actor_id: Some(&member_id), actor_name: None, action: "member.join", resource_type: "member", resource_id: Some(&member_id), resource_name: &name, metadata: json!({}) });
    let mut out = json!({
        "user": { "id": user_id, "email": Value::Null, "name": name },
        "household": household_of(&hub, &household_id),
        "remoteKey": hex::encode(remote_key(&hub)),
        "hubId": central_hub_id(&hub),
        "lanUrl": lan_base_url(hub.config.port),
    });
    if let (Value::Object(o), Value::Object(t)) = (&mut out, tokens::member_device_tokens(hub.store.secret(), &user_id, &household_id, &name)) {
        o.extend(t);
    }
    created(out)
}

async fn cancel(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let mut db_ = hub.store.db();
    let Some(invite) = db::one(&db_, "SELECT id, member_id, code, token, name FROM invites WHERE id = ? AND household_id = ?", p![id, household]) else {
        return error(404, "Invite not found.");
    };
    if let Ok(tx) = db_.transaction() {
        try_run!(&tx, "DELETE FROM invites WHERE id = ?", p![id]);
        // The member slot stops showing "Invited".
        try_run!(&tx, "UPDATE members SET pending = 0 WHERE id = ? AND household_id = ?", p![invite["member_id"].clone(), household]);
        let _ = tx.commit();
    }
    drop(db_);
    relay::unregister_remote_invite(&hub, &db::s(&invite, "code"), &db::s(&invite, "token"));
    log_activity(&hub, &user, "member.invite_cancel", "member", db::text(&invite, "member_id").as_deref(), &db::s(&invite, "name"), json!({}));
    no_content()
}
