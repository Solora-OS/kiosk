//! /api/v1/auth (routes/auth.ts): central account sign-in provisions the
//! household the first time (with the setup code), sessions, the wall's
//! optional auto-login, and refreshing an account-less phone.

use crate::auth::User;
use crate::http::{error, ok, Body};
use crate::db;
use crate::{p, realtime, relay, store, tokens, try_run, Hub};
use axum::extract::State;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use hmac::{Hmac, Mac};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/session", post(create_session).get(session))
        .route("/me", get(session))
        .route("/kiosk-autologin", post(kiosk_autologin))
        .route("/device-refresh", post(device_refresh))
        .route("/account", axum::routing::delete(delete_account))
}

/// 32-byte AES-256-GCM key for off-network relay payloads: HMAC(secret, "lumora-remote-access").
/// The label is a wire constant from before the Solora rename: phones keep the derived key.
pub fn remote_key(hub: &Hub) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(hub.store.secret().as_bytes()).expect("any key length works");
    mac.update(b"lumora-remote-access");
    mac.finalize().into_bytes().into()
}

/// The central hub id: the `sub` of this hub's central JWT.
pub fn central_hub_id(hub: &Hub) -> Value {
    hub.central
        .hub_jwt()
        .and_then(|jwt| tokens::peek(&jwt))
        .and_then(|c| c.get("sub").cloned())
        .unwrap_or(Value::Null)
}

fn first_upper(s: &str) -> String {
    s.chars().next().map(|c| c.to_uppercase().collect()).unwrap_or_default()
}

async fn create_session(State(hub): State<Arc<Hub>>, body: Body) -> Response {
    let Some(access_token) = body.str("access_token").filter(|s| !s.is_empty()) else {
        return error(400, "access_token is required.");
    };
    let Some(account) = hub.keys.verify(access_token).await else {
        return error(401, "Invalid or expired token. Sign in again.");
    };
    let name = if !account.name.is_empty() {
        account.name.clone()
    } else {
        Some(account.email.split('@').next().unwrap_or("")).filter(|s| !s.is_empty()).unwrap_or("User").to_string()
    };
    let mut db = hub.store.db();
    let existing: Option<(String, String, String, String)> = db
        .query_row("SELECT id, household_id, name, email FROM users WHERE account_id = ?", [&account.sub], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .ok()
        .flatten();
    let user = match existing {
        Some(u) => u,
        None => {
            // First sign-in: only with the code shown on the hub's own screen.
            if !hub.store.setup_code_matches(body.str("setupCode")) {
                return error(403, "That setup code doesn't match. It's shown on your hub's screen.");
            }
            let households: i64 = db.query_row("SELECT COUNT(*) FROM households", [], |r| r.get(0)).unwrap_or(0);
            if households > 0 {
                return error(409, "This hub already has a household. Sign in instead of creating a new one.");
            }
            let (user_id, household_id, member_id, calendar_id) = (store::uuid(), store::uuid(), store::uuid(), store::uuid());
            let household_name = body.text("household_name").unwrap_or_else(|| format!("{name}'s Family"));
            let tx = match db.transaction() {
                Ok(t) => t,
                Err(_) => return error(500, "Something went wrong."),
            };
            let done = (|| -> rusqlite::Result<()> {
                tx.execute("INSERT INTO households (id, name) VALUES (?, ?)", [&household_id, &household_name])?;
                tx.execute("INSERT INTO users (id, household_id, email, name, account_id) VALUES (?, ?, ?, ?, ?)", [&user_id, &household_id, &account.email, &name, &account.sub])?;
                tx.execute(
                    "INSERT INTO members (id, household_id, user_id, name, initial, color, role, permissions, account)
                     VALUES (?, ?, ?, ?, ?, 'blue', 'admin', '[]', ?)",
                    params![member_id, household_id, user_id, name, first_upper(&name), account.email],
                )?;
                tx.execute(
                    "INSERT INTO calendars (id, household_id, name, color, member_ids) VALUES (?, ?, 'Family', 'blue', ?)",
                    params![calendar_id, household_id, serde_json::to_string(&[&member_id]).unwrap()],
                )?;
                // The hub's own screen joins the new household; other displays still pair.
                tx.execute("UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE household_id IS NULL AND on_hub = 1", [&household_id])?;
                Ok(())
            })()
            .and_then(|_| tx.commit());
            if done.is_err() {
                return error(500, "Something went wrong.");
            }
            println!("[auth] Provisioned local user  account_id={}  user_id={user_id}", account.sub);
            (user_id, household_id, name.clone(), account.email.clone())
        }
    };
    let household_name: String = db.query_row("SELECT name FROM households WHERE id = ?", [&user.1], |r| r.get(0)).unwrap_or_default();
    drop(db);
    ok(json!({
        "user": { "id": user.0, "email": user.3, "name": user.2 },
        "household": { "id": user.1, "name": household_name },
        "remoteKey": hex::encode(remote_key(&hub)),
        "hubId": central_hub_id(&hub),
    }))
}

async fn session(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let db = hub.store.db();
    let household = |id: &str| -> Option<Value> {
        db.query_row("SELECT id, name FROM households WHERE id = ?", [id], |r| Ok(json!({ "id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)? })))
            .optional()
            .ok()
            .flatten()
    };
    if user.is_kiosk() {
        let device: Option<(String, Option<String>)> = db
            .query_row("SELECT device_name, household_id FROM kiosk_devices WHERE id = ?", [&user.sub], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()
            .ok()
            .flatten();
        let name = device.as_ref().map(|d| d.0.clone()).or(user.name.clone()).unwrap_or_else(|| "Kiosk".into());
        let hh = device.and_then(|d| d.1).and_then(|h| household(&h)).unwrap_or(Value::Null);
        return ok(json!({ "user": { "id": user.sub, "email": Value::Null, "name": name }, "household": hh, "isKiosk": true }));
    }
    match user.household().and_then(household) {
        // Fields the token doesn't carry are left out, as res.json drops undefined.
        Some(hh) => ok(json!({ "user": crate::http::defined(json!({ "id": user.sub, "email": user.email, "name": user.name })), "household": hh })),
        None => error(404, "Household not found. Call POST /auth/session to provision."),
    }
}

async fn kiosk_autologin(State(hub): State<Arc<Hub>>) -> Response {
    let config: Value = std::fs::read_to_string(hub.store.dir.join("kiosk-autologin.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null);
    let Some(account_id) = config.get("account_id").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return ok(json!({ "enabled": false }));
    };
    let db = hub.store.db();
    let user: Option<(String, String, String, String)> = db
        .query_row("SELECT id, household_id, name, email FROM users WHERE account_id = ?", [account_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .optional()
        .ok()
        .flatten();
    let Some((id, household_id, name, email)) = user else {
        return error(404, "No local user found for configured account_id. Sign in manually first.");
    };
    let household_name: Option<String> = db.query_row("SELECT name FROM households WHERE id = ?", [&household_id], |r| r.get(0)).optional().ok().flatten();
    let Some(household_name) = household_name else { return error(404, "Household not found.") };
    let token = tokens::sign(hub.store.secret(), json!({ "sub": id, "householdId": household_id, "email": email, "name": name, "role": "member" }), "24h");
    ok(json!({ "token": token, "user": { "id": id, "email": email, "name": name }, "household": { "id": household_id, "name": household_name } }))
}

async fn device_refresh(State(hub): State<Arc<Hub>>, body: Body) -> Response {
    let Some(refresh) = body.str("refresh_token").filter(|s| !s.is_empty()) else {
        return error(400, "refresh_token is required.");
    };
    let Some(claims) = tokens::verify_refresh(hub.store.secret(), refresh) else {
        return error(401, "Sign-in expired. Ask a parent for a new invite.");
    };
    let sub = claims.get("sub").and_then(Value::as_str).unwrap_or("");
    let user: Option<(String, String, String)> = hub
        .store
        .db()
        .query_row("SELECT id, household_id, name FROM users WHERE id = ? AND device_only = 1", [sub], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .ok()
        .flatten();
    let Some((id, household_id, name)) = user else {
        return error(401, "This phone has been signed out of the household.");
    };
    ok(tokens::member_device_tokens(hub.store.secret(), &id, &household_id, &name))
}

/// DELETE /account: the caller leaves this hub for good. Their local user and
/// member profile go; when they're the household's last admin the whole
/// household goes (every table cascades from households, plus the photo
/// files) and the hub is back to unclaimed. The phone deletes the central
/// account separately.
async fn delete_account(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if user.is_kiosk() {
        return error(403, "Sign in on your phone to delete your account.");
    }
    let me = user.sub.clone();
    let Some(household) = user.household().map(str::to_string) else {
        try_run!(&hub.store.db(), "DELETE FROM users WHERE id = ?", p![me]);
        return ok(json!({ "wiped": false }));
    };
    let mut db_ = hub.store.db();
    let admin = db::one(&db_, "SELECT role FROM members WHERE user_id = ? AND household_id = ?", p![me, household])
        .is_some_and(|r| db::s(&r, "role") == "admin");
    let others = db::one(
        &db_,
        "SELECT COUNT(*) AS n FROM members WHERE household_id = ? AND role = 'admin' AND user_id IS NOT NULL AND user_id != ?",
        p![household, me],
    )
    .map(|r| db::number(&r, "n"))
    .unwrap_or(0.0);
    let wiped = admin && others == 0.0;

    if wiped {
        let photos = db::all(&db_, "SELECT filename FROM photos WHERE household_id = ?", p![household]);
        let invites = db::all(&db_, "SELECT code, token FROM invites WHERE household_id = ?", p![household]);
        try_run!(&db_, "DELETE FROM households WHERE id = ?", p![household]);
        drop(db_);
        let dir = hub.store.dir.join("photos");
        for ph in &photos {
            let name = db::s(ph, "filename");
            let _ = std::fs::remove_file(dir.join(name.rsplit('/').next().unwrap_or(&name)));
        }
        for i in &invites {
            relay::unregister_remote_invite(&hub, &db::s(i, "code"), &db::s(i, "token"));
        }
        eprintln!("[auth] Account deleted by last admin; household {household} wiped");
    } else {
        let members = db::all(&db_, "SELECT id FROM members WHERE user_id = ? AND household_id = ?", p![me, household]);
        let mine = "SELECT id FROM members WHERE user_id = ?";
        let invites = db::all(&db_, &format!("SELECT code, token FROM invites WHERE member_id IN ({mine})"), p![me]);
        if let Ok(tx) = db_.transaction() {
            try_run!(&tx, &format!("DELETE FROM invites WHERE member_id IN ({mine})"), p![me]);
            try_run!(&tx, "DELETE FROM members WHERE user_id = ?", p![me]);
            try_run!(&tx, "DELETE FROM users WHERE id = ?", p![me]);
            let _ = tx.commit();
        }
        drop(db_);
        for i in &invites {
            relay::unregister_remote_invite(&hub, &db::s(i, "code"), &db::s(i, "token"));
        }
        for m in &members {
            realtime::broadcast(&hub, &household, "members:deleted", json!(db::s(m, "id")));
        }
    }
    ok(json!({ "wiped": wiped }))
}
