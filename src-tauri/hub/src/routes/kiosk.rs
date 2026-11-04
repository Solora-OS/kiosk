//! /api/v1/kiosk (and /api/v1/kiosk-devices): display registration, pairing,
//! setup, heartbeat, display state and central tokens (routes/kiosk.ts).

use crate::auth::User;
use crate::http::{created, error, no_content, ok, Body, Peer};
use crate::{central, realtime, store, tokens, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use rand::Rng;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/register", post(register))
        .route("/state", get(state))
        .route("/setup", post(setup))
        .route("/heartbeat", post(heartbeat))
        .route("/kiosk-devices/heartbeat", post(heartbeat))
        .route("/devices", get(devices))
        .route("/devices/{device_id}", delete(remove_device))
        .route("/claim", post(claim))
        .route("/unpair", post(unpair))
        .route("/display-state", post(display_state))
        .route("/central-token/{local_device_id}", get(central_token))
        .route("/request-central-token", post(request_central_token))
}

/// Six digits, so a display code can't be mistaken for an invite code (ABC-123).
fn pairing_code() -> String {
    format!("{:06}", rand::thread_rng().gen_range(0..1_000_000))
}

async fn register(State(hub): State<Arc<Hub>>, peer: Peer, body: Body) -> Response {
    let name = body.text("device_name").unwrap_or_else(|| "Kiosk Display".into());
    let id = store::uuid();
    let code = pairing_code();
    let token = tokens::sign(hub.store.secret(), json!({ "sub": id, "role": "kiosk", "name": name }), "87600h");
    let token_hash = hex::encode(Sha256::digest(token.as_bytes()));
    let on_hub = peer.from_this_hub();
    let db = hub.store.db();
    let family: Option<String> = if on_hub {
        db.query_row("SELECT id FROM households ORDER BY created_at LIMIT 1", [], |r| r.get(0)).optional().ok().flatten()
    } else {
        None
    };
    let res = db.execute(
        "INSERT INTO kiosk_devices
         (id, device_token, device_name, pairing_code, setup_complete, is_online, last_heartbeat, on_hub, household_id)
         VALUES (?, ?, ?, ?, 0, 1, datetime('now'), ?, ?)",
        params![id, token_hash, name, if family.is_some() { None } else { Some(&code) }, on_hub as i64, family],
    );
    if res.is_err() {
        return error(500, "Something went wrong.");
    }
    created(json!({ "id": id, "device_token": token, "pairing_code": if family.is_some() { Value::Null } else { json!(code) } }))
}

/// The family a display running on the hub itself belongs to. The hub's own
/// screen is part of its family whenever there is one: it never waits for a
/// phone to pair it, since a phone still on another hub could never find its code.
fn own_family(db: &rusqlite::Connection, device_id: &str) -> Option<String> {
    let on_hub = db.query_row("SELECT on_hub FROM kiosk_devices WHERE id = ?", [device_id], |r| r.get::<_, i64>(0)).optional().ok().flatten()? != 0;
    if !on_hub {
        return None;
    }
    db.query_row("SELECT id FROM households ORDER BY created_at LIMIT 1", [], |r| r.get(0)).optional().ok().flatten()
}

async fn state(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let db = hub.store.db();
    if let Some(family) = own_family(&db, &user.sub) {
        db.execute("UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE id = ? AND household_id IS NULL", [&family, &user.sub]).ok();
    }
    type Row = (String, Option<String>, Option<String>, Option<String>, i64, Option<String>, Option<String>);
    let row: Option<Row> = db
        .query_row(
            "SELECT id, device_name, pairing_code, household_id, setup_complete, language, timezone FROM kiosk_devices WHERE id = ?",
            [&user.sub],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
        )
        .optional()
        .ok()
        .flatten();
    let Some((id, name, code, household, setup_complete, language, timezone)) = row else { return ok(json!({ "found": false })) };
    let household_name: Option<String> = household
        .as_ref()
        .and_then(|h| db.query_row("SELECT name FROM households WHERE id = ?", [h], |r| r.get(0)).optional().ok().flatten());
    ok(json!({
        "found": true,
        "device_id": id,
        "device_name": name,
        "paired": household.is_some(),
        "pairing_code": code,
        "household_id": household,
        "household_name": household_name,
        "on_hub": own_family(&db, &id).is_some(),
        "setup_complete": setup_complete != 0,
        "language": language,
        "timezone": timezone,
    }))
}

async fn setup(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    hub.store.db().execute(
        "UPDATE kiosk_devices
         SET device_name = COALESCE(?, device_name), language = COALESCE(?, language), timezone = COALESCE(?, timezone), setup_complete = 1
         WHERE id = ?",
        params![body.str("device_name"), body.str("language"), body.str("timezone"), user.sub],
    ).ok();
    ok(json!({ "ok": true }))
}

/// A number or string column value as SQLite would take it from Node (null stays null).
fn sql_value(v: Option<&Value>) -> rusqlite::types::Value {
    use rusqlite::types::Value as V;
    match v {
        Some(Value::Number(n)) => n.as_i64().map(V::Integer).unwrap_or_else(|| V::Real(n.as_f64().unwrap_or(0.0))),
        Some(Value::String(s)) => V::Text(s.clone()),
        Some(Value::Bool(b)) => V::Integer(*b as i64),
        _ => V::Null,
    }
}

async fn heartbeat(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    hub.store.db().execute(
        "UPDATE kiosk_devices
         SET wifi_signal = COALESCE(?, wifi_signal), ping_latency_ms = COALESCE(?, ping_latency_ms), battery_percent = ?,
             device_info = COALESCE(?, device_info), is_online = 1, last_heartbeat = datetime('now')
         WHERE id = ?",
        params![sql_value(body.get("wifi_signal")), sql_value(body.get("ping_latency_ms")), sql_value(body.get("battery_percent")), sql_value(body.get("device_info")), user.sub],
    ).ok();
    ok(json!({ "ok": true }))
}

fn num(v: Option<f64>) -> Value {
    v.map(|n| if n.fract() == 0.0 { json!(n as i64) } else { json!(n) }).unwrap_or(Value::Null)
}

async fn devices(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(household) = user.household() else { return ok(json!([])) };
    let db = hub.store.db();
    let mut stmt = match db.prepare(
        "SELECT id, device_name, household_id, ping_latency_ms, battery_percent, wifi_signal, last_heartbeat FROM kiosk_devices WHERE household_id = ?",
    ) {
        Ok(s) => s,
        Err(_) => return error(500, "Something went wrong."),
    };
    let rows: Vec<Value> = stmt
        .query_map([household], |r| {
            Ok(json!({
                "device_id": r.get::<_, String>(0)?,
                "device_name": r.get::<_, Option<String>>(1)?.unwrap_or_else(|| "Solora Display".into()),
                "household_id": r.get::<_, String>(2)?,
                "ping_ms": num(r.get(3)?),
                "battery_pct": num(r.get(4)?),
                "wifi_signal": num(r.get(5)?),
                "last_heartbeat": r.get::<_, Option<String>>(6)?,
            }))
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default();
    ok(Value::Array(rows))
}

async fn remove_device(State(hub): State<Arc<Hub>>, user: User, Path(device_id): Path<String>) -> Response {
    let Some(household) = user.household() else { return error(403, "Only authenticated household members can unpair a device.") };
    let db = hub.store.db();
    let found = db.query_row("SELECT id FROM kiosk_devices WHERE id = ? AND household_id = ?", [&device_id, household], |_| Ok(())).is_ok();
    if !found {
        return error(404, "Device not found in your household.");
    }
    db.execute("UPDATE kiosk_devices SET household_id = NULL, pairing_code = ?, setup_complete = 0 WHERE id = ?", params![pairing_code(), device_id]).ok();
    no_content()
}

async fn claim(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household() else { return error(403, "Only authenticated household members can claim a device.") };
    let raw: String = body.str("pairing_code").unwrap_or("").to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if raw.is_empty() {
        return error(400, "pairing_code is required.");
    }
    let db = hub.store.db();
    let device: Option<(String, Option<String>, String)> = db
        .query_row("SELECT id, household_id, device_name FROM kiosk_devices WHERE REPLACE(pairing_code, '-', '') = ?", [&raw], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .ok()
        .flatten();
    let Some((id, existing, name)) = device else {
        let family: Option<String> = db.query_row("SELECT name FROM households WHERE id = ?", [household], |r| r.get(0)).optional().ok().flatten();
        return error(404, &not_found_message(family.as_deref()));
    };
    if existing.as_deref().is_some_and(|h| h != household) {
        return error(409, "This hub is already claimed by a different household.");
    }
    db.execute("UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE id = ?", [household, &id]).ok();
    let household_name: Option<String> = db.query_row("SELECT name FROM households WHERE id = ?", [household], |r| r.get(0)).optional().ok().flatten();
    ok(json!({
        "ok": true,
        "device_id": id,
        "device_name": name,
        "household_id": household,
        "household_name": household_name,
        "claimed_by": user.sub,
    }))
}

/// A display code this hub doesn't have usually means the phone is connected to
/// a different hub than the screen (e.g. after moving to a new hub).
fn not_found_message(family: Option<&str>) -> String {
    let hub = family.map(|f| format!("{f}'s hub")).unwrap_or_else(|| "the hub this phone uses".into());
    format!("That display code isn't on {hub}. Check the code, or if the screen belongs to another hub, connect this phone to that hub first (Settings › Connect to a different hub).")
}

async fn unpair(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if own_family(&hub.store.db(), &user.sub).is_some() {
        return ok(json!({ "ok": true, "pairing_code": Value::Null, "on_hub": true }));
    }
    let code = pairing_code();
    hub.store.db().execute("UPDATE kiosk_devices SET household_id = NULL, pairing_code = ?, setup_complete = 0 WHERE id = ?", [&code, &user.sub]).ok();
    ok(json!({ "ok": true, "pairing_code": code }))
}

async fn display_state(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household().filter(|_| user.is_kiosk()).map(str::to_string) else {
        return error(403, "Only a paired display can report its state.");
    };
    let Some(state @ Value::Object(_)) = body.get("state").cloned() else {
        return error(400, "state must be an object.");
    };
    let text = serde_json::to_string(&state).unwrap_or_default();
    // JSON.stringify length counts UTF-16 units.
    if text.encode_utf16().count() > 8_000 {
        return error(413, "state is too large.");
    }
    let updated_at = store::now_iso();
    hub.store
        .db()
        .execute("UPDATE kiosk_devices SET display_state = ?, display_state_at = ? WHERE id = ? AND household_id = ?", [&text, &updated_at, &user.sub, &household])
        .ok();
    realtime::broadcast(&hub, &household, "display:state", json!({ "deviceId": user.sub, "state": state, "updatedAt": updated_at }));
    ok(json!({ "ok": true }))
}

async fn central_token(State(hub): State<Arc<Hub>>, _user: User, Path(local_device_id): Path<String>) -> Response {
    match hub.central.kiosk(&local_device_id) {
        Some(k) => ok(json!({ "token": k.central_jwt })),
        None => error(503, "Central registration pending — retry in a few seconds"),
    }
}

async fn request_central_token(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if user.sub.is_empty() {
        return error(400, "Could not resolve device ID from token");
    }
    if let Some(k) = hub.central.kiosk(&user.sub) {
        return ok(json!({ "token": k.central_jwt }));
    }
    match central::register_kiosk_on_demand(&hub, &user.sub).await {
        Some(token) => ok(json!({ "token": token })),
        None => error(503, "Hub could not reach the central API — check CENTRAL_API_URL and ensure the hub is registered"),
    }
}
