//! /api/v1/hub/info and /setup (routes/hub.ts), plus /health,
//! /central-identity and /connection-health (index.ts).

use crate::auth::User;
use crate::central::Central;
use crate::http::{error, lan_base_url, ok, Peer};
use crate::Hub;
use axum::extract::State;
use axum::response::Response;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// Unauthenticated identity probe a phone calls after finding the hub on the LAN.
pub async fn info(State(hub): State<Arc<Hub>>) -> Response {
    let id = hub.store.identity();
    ok(json!({ "hub_id": id.id, "name": id.name, "claimed": hub.store.households() > 0 }))
}

/// The setup code and LAN address, for the hub's own screen only, before setup.
pub async fn setup(State(hub): State<Arc<Hub>>, peer: Peer) -> Response {
    if !peer.from_this_hub() {
        return error(403, "The setup code is only shown on the hub itself.");
    }
    if hub.store.households() > 0 {
        return error(409, "This hub is already set up.");
    }
    ok(json!({ "setupCode": hub.store.setup_code(), "hubUrl": lan_base_url(hub.config.port), "name": hub.store.identity().name }))
}

pub async fn health() -> Response {
    ok(json!({ "status": "ok" }))
}

pub async fn central_identity(State(hub): State<Arc<Hub>>, _user: User) -> Response {
    match Central::read_file(&hub) {
        Some(c) => ok(json!({ "hub_id": c.hub_id })),
        None => error(503, "Hub not yet registered with central API — retry in a few seconds"),
    }
}

async fn ping(hub: &Hub, base: &str) -> Value {
    match hub.http.get(format!("{base}/health")).timeout(Duration::from_secs(3)).send().await {
        Ok(r) => json!({ "ok": r.status().is_success(), "status": r.status().as_u16() }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn merge(mut base: Value, extra: Value) -> Value {
    if let (Value::Object(b), Value::Object(e)) = (&mut base, extra) {
        b.extend(e);
    }
    base
}

pub async fn connection_health(State(hub): State<Arc<Hub>>, _user: User) -> Response {
    let creds = Central::read_file(&hub);
    let api_url = hub.central.api_url.clone();
    let socket_url = hub.central.socket_url.clone();
    let api = ping(&hub, &api_url).await;
    let socket = ping(&hub, &socket_url).await;
    let connected = hub.central.is_connected();
    let kiosks: Vec<(String, String, Option<String>)> = {
        let db = hub.store.db();
        let mut stmt = match db.prepare("SELECT id, device_name, household_id FROM kiosk_devices") {
            Ok(s) => s,
            Err(_) => return error(500, "Something went wrong."),
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
    };
    let kiosk = |id: &str| creds.as_ref().and_then(|c| c.kiosks.get(id)).cloned();
    let kiosks: Vec<Value> = kiosks
        .into_iter()
        .map(|(id, name, household)| {
            let k = kiosk(&id);
            json!({
                "local_device_id": id,
                "device_name": name,
                "paired": household.is_some(),
                "central_registered": k.is_some(),
                "central_device_id": k.as_ref().and_then(|k| k.get("central_device_id")).cloned().unwrap_or(Value::Null),
                "has_central_jwt": k.as_ref().and_then(|k| k.get("central_jwt")).and_then(Value::as_str).is_some_and(|s| !s.is_empty()),
            })
        })
        .collect();
    let mut next_steps: Vec<String> = Vec::new();
    if creds.is_none() {
        next_steps.push("Hub not registered with central API — it keeps retrying; check the hub's internet and CENTRAL_API_URL".into());
    }
    if !connected {
        next_steps.push("Hub not connected to central socket — check CENTRAL_SOCKET_URL and hub JWT".into());
    }
    if api["ok"] != json!(true) {
        next_steps.push(format!("Central API unreachable at {api_url}"));
    }
    if socket["ok"] != json!(true) {
        next_steps.push(format!("Central socket unreachable at {socket_url}"));
    }
    for k in &kiosks {
        if k["paired"] == json!(true) && k["central_registered"] == json!(false) {
            next_steps.push(format!(
                "Kiosk \"{}\" ({}) is paired locally but not registered with central — hub will register on next restart",
                k["device_name"].as_str().unwrap_or(""),
                k["local_device_id"].as_str().unwrap_or("")
            ));
        }
    }
    ok(json!({
        "ts": crate::store::now_iso(),
        "hub": {
            "registered_with_central": creds.is_some(),
            "hub_id": creds.as_ref().map(|c| json!(c.hub_id)).unwrap_or(Value::Null),
            "central_socket_connected": connected,
        },
        "central_api": merge(json!({ "url": api_url }), api),
        "central_socket": merge(json!({ "url": socket_url }), socket),
        "kiosks": kiosks,
        "next_steps": next_steps,
    }))
}
