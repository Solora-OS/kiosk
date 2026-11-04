//! What Solora (the manufacturer) does to this hub, told to the family, and
//! the household's side of support access (services/solora-support.ts and
//! routes/support.ts).
//!
//! - Every action Solora takes arrives from central (live as
//!   `manufacturer:action`, or caught up from GET /household/actions after the
//!   hub was offline) and goes in the activity log as `solora.<action>`,
//!   deduplicated by central's audit id.
//! - A support access request (`support:request`) notifies the admins, who
//!   grant or deny it in Settings › Privacy & support (/api/v1/support).

use crate::auth::User;
use crate::household::{caller_member, notify_members, write_log, LogEntry, Note};
use crate::http::{error, ok, Body};
use crate::Hub;
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

// ---- Calling central as this hub ---------------------------------------------------

pub enum CentralError {
    /// Not linked yet, or central can't be reached: 503.
    Unavailable(String),
    /// Central answered with an error: its status (4xx) or 502.
    Answered(u16, String),
}

impl CentralError {
    fn response(self) -> Response {
        match self {
            CentralError::Unavailable(m) => error(503, m),
            CentralError::Answered(s, m) => error(if s < 500 { s } else { 502 }, m),
        }
    }
}

pub async fn central_fetch(hub: &Hub, method: &str, path: &str, body: Option<Value>) -> Result<Value, CentralError> {
    let Some(jwt) = hub.central.hub_jwt() else {
        return Err(CentralError::Unavailable("This hub isn't connected to Solora's service yet.".into()));
    };
    let mut req = hub
        .http
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{}{path}", hub.central.api_url))
        .bearer_auth(jwt)
        .timeout(Duration::from_secs(8));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|_| CentralError::Unavailable("Solora's service can't be reached right now.".into()))?;
    let status = res.status().as_u16();
    let json = res.json::<Value>().await.unwrap_or(Value::Null);
    if !(200..300).contains(&status) {
        let message = json.get("error").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("Solora's service answered {status}"));
        return Err(CentralError::Answered(status, message));
    }
    Ok(json)
}

// ---- Solora's actions ------------------------------------------------------------------

fn household_id(hub: &Hub) -> Option<String> {
    hub.store.db().query_row("SELECT id FROM households ORDER BY created_at LIMIT 1", [], |r| r.get(0)).optional().ok().flatten()
}

/// A display's name from its central device id (phones aren't known by id here).
fn device_name(hub: &Hub, central_id: Option<&str>) -> String {
    let Some(central_id) = central_id else { return String::new() };
    let rows: Vec<(String, String)> = {
        let db = hub.store.db();
        let Ok(mut stmt) = db.prepare("SELECT id, device_name FROM kiosk_devices") else { return String::new() };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|r| r.flatten().collect()).unwrap_or_default()
    };
    rows.into_iter()
        .find(|(id, _)| hub.central.kiosk(id).is_some_and(|k| k.central_device_id == central_id))
        .map(|(_, name)| name)
        .unwrap_or_default()
}

/// One line a family member can read.
pub fn describe(action: &str, name: &str) -> String {
    let it = if name.is_empty() { "a device" } else { name };
    match action {
        "device.reboot" => format!("Restarted {it}"),
        "device.report_status" => format!("Checked on {it}"),
        "device.lock" => format!("Changed the lock on {it}"),
        "device.revoke" => format!("Disconnected {it} from Solora's service"),
        "device.logs" => format!("Read {it}'s diagnostic logs, with your permission"),
        "hub.command" => "Sent a command to your wall displays".into(),
        "hub.revoke" => "Disconnected your hub from Solora's service".into(),
        "ota.push" => "Sent a software update".into(),
        "ota.cancel" => "Cancelled a software update".into(),
        "notice.send" => "Sent a service notice".into(),
        "support.request" => "Asked for access to diagnostics".into(),
        "support.expired" => "Support access ended".into(),
        other => format!("Solora: {other}"),
    }
}

/// `recordSoloraAction`: one action from central, once.
pub fn record_action(hub: &Hub, a: &Value) {
    let Some(hh) = household_id(hub) else { return };
    let Some(central_id) = a.get("id").filter(|v| !v.is_null()) else { return };
    let seen = hub
        .store
        .db()
        .query_row(
            "SELECT 1 FROM activity_logs WHERE household_id = ? AND action LIKE 'solora.%' AND json_extract(metadata, '$.central_id') = ?",
            rusqlite::params![hh, central_id.as_i64().map(rusqlite::types::Value::Integer).unwrap_or_else(|| rusqlite::types::Value::Text(central_id.to_string()))],
            |_| Ok(()),
        )
        .is_ok();
    if seen {
        return;
    }
    let text = |k: &str| a.get(k).and_then(Value::as_str);
    let action = text("action").unwrap_or("");
    let target_type = text("target_type");
    let name = if target_type == Some("device") { device_name(hub, text("target_id")) } else { String::new() };
    write_log(hub, LogEntry {
        household_id: &hh,
        actor_id: None,
        actor_name: Some("Solora"),
        action: &format!("solora.{action}"),
        resource_type: target_type.unwrap_or("hub"),
        resource_id: text("target_id"),
        resource_name: &name,
        metadata: json!({
            "central_id": central_id, "at": a.get("at"), "reason": a.get("reason"), "approved": a.get("approved"),
            "summary": describe(action, &name),
        }),
    });
}

/// `syncSoloraActions`: anything Solora did while this hub was offline.
pub async fn sync_actions(hub: &Hub) {
    let Some(hh) = household_id(hub) else { return };
    let last: Option<i64> = hub
        .store
        .db()
        .query_row(
            "SELECT max(CAST(json_extract(metadata, '$.central_id') AS INTEGER)) FROM activity_logs WHERE household_id = ? AND action LIKE 'solora.%'",
            [&hh],
            |r| r.get(0),
        )
        .unwrap_or(None);
    match central_fetch(hub, "GET", &format!("/household/actions?after_id={}", last.unwrap_or(0)), None).await {
        Ok(v) => {
            for a in v["actions"].as_array().into_iter().flatten() {
                record_action(hub, a);
            }
        }
        Err(CentralError::Unavailable(m) | CentralError::Answered(_, m)) => eprintln!("[central] Solora activity sync failed: {m}"),
    }
}

/// `onSupportRequest`: the admins hear about it.
pub fn on_support_request(hub: &Arc<Hub>, grant: &Value) {
    let Some(hh) = household_id(hub) else { return };
    let admins: Vec<String> = {
        let db = hub.store.db();
        let Ok(mut stmt) = db.prepare("SELECT id FROM members WHERE household_id = ? AND role = 'admin'") else { return };
        stmt.query_map([&hh], |r| r.get(0)).map(|r| r.flatten().collect()).unwrap_or_default()
    };
    if admins.is_empty() {
        return;
    }
    let reason = grant.get("reason").and_then(Value::as_str).unwrap_or("");
    let body = format!("{reason} Open Settings › Privacy & support to allow or deny.");
    notify_members(hub, &hh, Some(admins), Note { title: "Solora Support is asking for access", body: &body, time: "", reference: Some("support") });
}

// ---- /api/v1/support (household admins only) -----------------------------------------

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/activity", get(activity))
        .route("/grants", get(grants))
        .route("/grants/{id}/respond", post(respond))
        .route("/grants/{id}/revoke", post(revoke))
        .route("/devices/{id}/lost", post(lost))
        .route("/{*rest}", axum::routing::any(not_found))
}

/// Unknown paths under /support: signed in and an admin first, then 404 (like Express).
pub async fn not_found(State(hub): State<Arc<Hub>>, user: User) -> Response {
    admin(&hub, &user).err().unwrap_or_else(|| error(404, "Not found."))
}

/// Only household admins decide what Solora may do. Not the wall display.
fn admin(hub: &Hub, user: &User) -> Result<(), Response> {
    match caller_member(hub, user) {
        Some(m) if m.role == "admin" => Ok(()),
        _ => Err(error(403, "Only family admins can manage Solora's access.")),
    }
}

/// encodeURIComponent, for ids put into a central path.
fn segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn activity(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if let Err(r) = admin(&hub, &user) {
        return r;
    }
    let db = hub.store.db();
    let Ok(mut stmt) = db.prepare(
        "SELECT id, action, resource_name, metadata, created_at FROM activity_logs
          WHERE household_id = ? AND (action LIKE 'solora.%' OR action LIKE 'support.%' OR action IN ('device.reported_lost', 'device.found'))
          ORDER BY created_at DESC LIMIT 100",
    ) else {
        return error(500, "Something went wrong.");
    };
    let rows: Vec<Value> = stmt
        .query_map([user.household().unwrap_or("")], |r| {
            let (id, action, name, meta, at): (String, String, Option<String>, Option<String>, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?);
            let meta: Value = meta.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or(json!({}));
            let s = |k: &str| meta.get(k).and_then(Value::as_str).map(str::to_string);
            Ok(json!({
                "id": id,
                "action": action,
                "bySolora": action.starts_with("solora."),
                "summary": s("summary").unwrap_or_else(|| action.clone()),
                "reason": s("reason"),
                "deviceName": name.filter(|n| !n.is_empty()),
                "at": s("at").unwrap_or(at),
            }))
        })
        .map(|r| r.flatten().collect())
        .unwrap_or_default();
    ok(Value::Array(rows))
}

async fn grants(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if let Err(r) = admin(&hub, &user) {
        return r;
    }
    match central_fetch(&hub, "GET", "/household/support-grants", None).await {
        Ok(v) => ok(v),
        Err(e) => e.response(),
    }
}

async fn respond(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if let Err(r) = admin(&hub, &user) {
        return r;
    }
    let decision = body.str("decision").filter(|d| *d == "grant" || *d == "deny");
    let Some(decision) = decision else { return error(400, "decision must be \"grant\" or \"deny\".") };
    let out = match central_fetch(&hub, "POST", &format!("/household/support-grants/{}/respond", segment(&id)), Some(json!({ "decision": decision }))).await {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let grant = out.get("grant").cloned().unwrap_or(Value::Null);
    let summary = if decision == "grant" {
        format!("Allowed Solora Support to read diagnostics for {} hours", grant["duration_hours"].as_i64().map(|h| h.to_string()).unwrap_or_else(|| grant["duration_hours"].to_string()))
    } else {
        "Denied Solora Support's request for diagnostics".into()
    };
    write_log(&hub, LogEntry {
        household_id: user.household().unwrap_or(""),
        actor_id: Some(&user.sub),
        actor_name: None,
        action: if decision == "grant" { "support.granted" } else { "support.denied" },
        resource_type: "support_grant",
        resource_id: grant["id"].as_str(),
        resource_name: "",
        metadata: json!({ "reason": grant.get("reason"), "summary": summary }),
    });
    ok(json!({ "grant": grant }))
}

async fn revoke(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if let Err(r) = admin(&hub, &user) {
        return r;
    }
    let out = match central_fetch(&hub, "POST", &format!("/household/support-grants/{}/revoke", segment(&id)), None).await {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let grant = out.get("grant").cloned().unwrap_or(Value::Null);
    write_log(&hub, LogEntry {
        household_id: user.household().unwrap_or(""),
        actor_id: Some(&user.sub),
        actor_name: None,
        action: "support.revoked",
        resource_type: "support_grant",
        resource_id: grant["id"].as_str(),
        resource_name: "",
        metadata: json!({ "summary": "Ended Solora Support's access" }),
    });
    ok(json!({ "grant": grant }))
}

async fn lost(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if let Err(r) = admin(&hub, &user) {
        return r;
    }
    let Some(lost) = body.get("lost").and_then(Value::as_bool) else { return error(400, "lost must be true or false.") };
    let household = user.household().unwrap_or("").to_string();
    let kiosk: Option<(String, String)> = hub
        .store
        .db()
        .query_row("SELECT id, device_name FROM kiosk_devices WHERE id = ? AND household_id = ?", [&id, &household], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()
        .ok()
        .flatten();
    let Some((kiosk_id, name)) = kiosk else { return error(404, "Display not found.") };
    let Some(creds) = hub.central.kiosk(&kiosk_id) else {
        return error(409, "This display isn't connected to Solora's service, so it can't be locked remotely.");
    };
    let out = match central_fetch(&hub, "POST", &format!("/household/devices/{}/lock", creds.central_device_id), Some(json!({ "locked": lost }))).await {
        Ok(v) => v,
        Err(e) => return e.response(),
    };
    let summary = if lost { format!("Reported {name} lost and locked it") } else { format!("Unlocked {name}") };
    write_log(&hub, LogEntry {
        household_id: &household,
        actor_id: Some(&user.sub),
        actor_name: None,
        action: if lost { "device.reported_lost" } else { "device.found" },
        resource_type: "kiosk",
        resource_id: Some(&kiosk_id),
        resource_name: &name,
        metadata: json!({ "summary": summary }),
    });
    ok(json!({ "locked": out.get("locked"), "delivered": out.get("delivered") }))
}
