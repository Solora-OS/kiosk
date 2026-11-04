//! A phone standing next to a wall display (routes/wall.ts), and changing the
//! wall from a phone (routes/hub-command.ts).
//!
//! Each wall broadcasts a Bluetooth beacon carrying the first 8 hex digits of
//! its device id; a phone that hears it up close reports here with its own
//! token (or a presence pass), the hub tells that wall someone walked up, and
//! for 30 s the phone can "throw" a photo or list onto it.

use crate::auth::{self, Refused, User};
use crate::db;
use crate::household::{log_activity, manages};
use crate::http::{error, ok, Body};
use crate::{p, realtime, tokens, Hub};
use axum::extract::{FromRequestParts, State};
use axum::http::request::Parts;
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

pub fn wall() -> Router<Arc<Hub>> {
    Router::new().route("/presence-token", post(presence_token)).route("/near", post(near)).route("/throw", post(throw))
}

pub fn hub_command() -> Router<Arc<Hub>> {
    Router::new().route("/command", post(command)).route("/display", get(display))
}

/// How long after a sighting a phone still counts as standing at that wall.
const NEAR: Duration = Duration::from_secs(30);
/// At most one approach event per member per wall in this window.
const APPROACH_EVERY: Duration = Duration::from_secs(5);

struct Near {
    device_ids: Vec<String>,
    at: Instant,
    announced_at: Instant,
}

fn near_by() -> &'static Mutex<HashMap<String, Near>> {
    static N: OnceLock<Mutex<HashMap<String, Near>>> = OnceLock::new();
    N.get_or_init(Default::default)
}

fn tag_of(device_id: &str) -> String {
    device_id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect::<String>().to_lowercase()
}

struct FamilyMember {
    id: String,
    name: Value,
    color: Value,
    household: String,
}

/// The calling phone's member, or the 403 to send.
fn member_of(hub: &Hub, user: &User) -> Result<FamilyMember, Response> {
    let Some(household) = user.household().filter(|_| !user.is_kiosk()) else {
        return Err(error(403, "Only a family member's phone can do this."));
    };
    let row = db::one(&hub.store.db(), "SELECT id, name, color FROM members WHERE user_id = ? AND household_id = ?", p![user.sub.clone(), household]);
    let Some(r) = row else { return Err(error(403, "You're not in this family yet.")) };
    Ok(FamilyMember { id: db::s(&r, "id"), name: r["name"].clone(), color: r["color"].clone(), household: household.to_string() })
}

/// requireAuth, or a presence pass (only /near takes one).
struct UserOrPresence(User);

impl FromRequestParts<Arc<Hub>> for UserOrPresence {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, hub: &Arc<Hub>) -> Result<Self, Response> {
        let token = auth::bearer(parts).unwrap_or_default();
        let presence: Option<Map<String, Value>> = (!token.is_empty() && !tokens::is_account_token(&token))
            .then(|| tokens::verify_any(hub.store.secret(), &token).ok())
            .flatten()
            .filter(|c| c.get("typ").and_then(Value::as_str) == Some("presence"));
        let Some(c) = presence else {
            return User::from_request_parts(parts, hub).await.map(UserOrPresence);
        };
        let text = |k: &str| c.get(k).and_then(Value::as_str).map(str::to_string);
        let user = User { sub: text("sub").unwrap_or_default(), household_id: text("householdId"), email: text("email"), name: text("name"), role: text("role") };
        if !auth::member_still_linked(hub, user.role.as_deref(), &user.sub, user.household_id.as_deref()) {
            return Err(Refused::SignedOut.response());
        }
        Ok(UserOrPresence(user))
    }
}

async fn presence_token(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let m = match member_of(&hub, &user) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let token = tokens::sign(hub.store.secret(), json!({ "sub": user.sub, "householdId": m.household, "role": "member", "typ": "presence" }), "365d");
    ok(json!({ "token": token }))
}

async fn near(State(hub): State<Arc<Hub>>, UserOrPresence(user): UserOrPresence, body: Body) -> Response {
    let m = match member_of(&hub, &user) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let tag = body.raw("tag").filter(|t| !t.is_null());
    if let Some(t) = tag {
        if !t.as_str().is_some_and(|s| s.len() == 8 && s.chars().all(|c| c.is_ascii_hexdigit())) {
            return error(400, "tag must be 8 hex digits.");
        }
    }
    let rssi = body.raw("rssi").and_then(Value::as_f64);
    if !rssi.is_some_and(|r| r.is_finite() && (-127.0..=0.0).contains(&r)) {
        return error(400, "rssi must be a number from -127 to 0.");
    }
    let tag = tag.and_then(Value::as_str).map(str::to_lowercase);
    let device_ids: Vec<String> = db::all(&hub.store.db(), "SELECT id FROM kiosk_devices WHERE household_id = ?", p![m.household])
        .iter()
        .map(|w| db::s(w, "id"))
        .filter(|id| tag.as_ref().is_none_or(|t| &tag_of(id) == t))
        .collect();
    if device_ids.is_empty() {
        return ok(json!({ "ok": true, "walls": [] }));
    }
    let now = Instant::now();
    let announce = {
        let mut map = near_by().lock().unwrap();
        let prev = map.get(&m.id);
        let same = prev.is_some_and(|p| p.device_ids == device_ids);
        let announce = !same || prev.is_some_and(|p| now.duration_since(p.announced_at) >= APPROACH_EVERY);
        let announced_at = if announce { now } else { prev.map(|p| p.announced_at).unwrap_or(now) };
        map.insert(m.id.clone(), Near { device_ids: device_ids.clone(), at: now, announced_at });
        announce
    };
    if announce {
        realtime::broadcast(&hub, &m.household, "wall:approach", json!({ "deviceIds": device_ids, "member": { "id": m.id, "name": m.name, "color": m.color } }));
    }
    ok(json!({ "ok": true, "walls": device_ids }))
}

async fn throw(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let m = match member_of(&hub, &user) {
        Ok(m) => m,
        Err(r) => return r,
    };
    let kind = body.str("kind").filter(|k| *k == "photo" || *k == "list");
    let Some(kind) = kind else { return error(400, "kind must be photo or list.") };
    let Some(id) = body.str("id").filter(|s| !s.is_empty()) else { return error(400, "id is required.") };
    let walls = near_by().lock().unwrap().get(&m.id).filter(|n| n.at.elapsed() <= NEAR).map(|n| n.device_ids.clone());
    let Some(walls) = walls else { return error(409, "Walk up to the wall display first, then throw.") };
    let sql = if kind == "photo" { "SELECT 1 FROM photos WHERE id = ? AND household_id = ?" } else { "SELECT 1 FROM lists WHERE id = ? AND household_id = ?" };
    if db::one(&hub.store.db(), sql, p![id, m.household]).is_none() {
        return error(404, "That isn't in this family's hub.");
    }
    realtime::broadcast(&hub, &m.household, "wall:throw", json!({ "deviceIds": walls, "kind": kind, "id": id, "from": { "id": m.id, "name": m.name, "color": m.color } }));
    ok(json!({ "ok": true, "walls": walls }))
}

// ---- Wall commands -------------------------------------------------------------------------

const NO_HUB_ACCESS: &str = "Only admins and members with hub access can control the display.";

fn percent(v: Option<&Value>, min: f64) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n >= min && *n <= 100.0)
}

/// parseCommand: the command, or the error to show.
fn parse_command(b: &Value) -> Result<Value, String> {
    let ty = b.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "restart" | "reload" | "clear_cache" | "display_sleep" | "display_wake" => Ok(json!({ "type": ty })),
        "set_orientation" => {
            const VALID: [&str; 5] = ["normal", "left", "right", "inverted", "portrait"];
            match b.get("orientation").and_then(Value::as_str).filter(|o| VALID.contains(o)) {
                Some(o) => Ok(json!({ "type": ty, "orientation": o })),
                None => Err(format!("Invalid orientation. Must be one of: {}", VALID.join(", "))),
            }
        }
        "set_idle_mins" => match b.get("minutes") {
            Some(Value::Null) => Ok(json!({ "type": ty, "minutes": null })),
            Some(m) if m.as_f64().is_some_and(|n| (1.0..=60.0).contains(&n)) => Ok(json!({ "type": ty, "minutes": m })),
            _ => Err("minutes must be a number 1–60, or null to disable.".into()),
        },
        "set_brightness" => percent(b.get("level"), 5.0).map(|l| json!({ "type": ty, "level": db::num(l.round()) })).ok_or_else(|| "level must be a number 5–100.".into()),
        "set_volume" => percent(b.get("level"), 0.0).map(|l| json!({ "type": ty, "level": db::num(l.round()) })).ok_or_else(|| "level must be a number 0–100.".into()),
        "set_muted" => b.get("muted").and_then(Value::as_bool).map(|m| json!({ "type": ty, "muted": m })).ok_or_else(|| "muted must be true or false.".into()),
        "set_theme" => b.get("theme").and_then(Value::as_str).filter(|t| ["light", "dark", "system"].contains(t)).map(|t| json!({ "type": ty, "theme": t })).ok_or_else(|| "theme must be light, dark or system.".into()),
        "set_season" => b
            .get("mode")
            .and_then(Value::as_str)
            .filter(|m| (1..=48).contains(&m.len()) && m.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
            .map(|m| json!({ "type": ty, "mode": m }))
            .ok_or_else(|| "mode must be \"auto\" or a season id.".into()),
        "set_season_effects" => b.get("on").and_then(Value::as_bool).map(|on| json!({ "type": ty, "on": on })).ok_or_else(|| "on must be true or false.".into()),
        _ => Err("Unknown command.".into()),
    }
}

fn command_label(ty: &str) -> Option<&'static str> {
    Some(match ty {
        "restart" => "restarted the wall display",
        "reload" => "reloaded the wall display",
        "clear_cache" => "cleared the wall display's cache",
        "display_sleep" => "put the wall display to sleep",
        "display_wake" => "woke the wall display",
        "set_orientation" => "rotated the wall display",
        "set_theme" => "changed the wall display's theme",
        _ => return None,
    })
}

pub async fn command(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household().map(str::to_string) else { return error(403, "Not associated with a household.") };
    if !manages(&hub, &user, "hub") {
        return error(403, NO_HUB_ACCESS);
    }
    let cmd = match parse_command(&body.0) {
        Ok(c) => c,
        Err(m) => return error(400, m),
    };
    let ty = cmd["type"].as_str().unwrap_or("").to_string();
    if let Some(label) = command_label(&ty) {
        log_activity(&hub, &user, "hub.command", "hub", None, label, json!({ "type": ty }));
    }
    realtime::broadcast(&hub, &household, "hub:command", cmd.clone());
    ok(json!({ "ok": true, "command": cmd }))
}

pub async fn display(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(household) = user.household().map(str::to_string) else { return ok(json!({ "displays": [] })) };
    if !manages(&hub, &user, "hub") {
        return error(403, NO_HUB_ACCESS);
    }
    let rows = db::all(&hub.store.db(),
        "SELECT id, device_name, display_state, display_state_at, last_heartbeat FROM kiosk_devices WHERE household_id = ? ORDER BY last_heartbeat DESC", p![household]);
    let displays: Vec<Value> = rows
        .iter()
        .map(|r| json!({
            "deviceId": r["id"],
            "name": db::text(r, "device_name").unwrap_or_else(|| "Solora Display".into()),
            "state": db::text(r, "display_state").and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!({})),
            "updatedAt": r["display_state_at"],
            "lastHeartbeat": r["last_heartbeat"],
        }))
        .collect();
    ok(json!({ "displays": displays }))
}
