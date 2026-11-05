//! What this hub does for the Solora console (central/src/routes/fleet.ts),
//! over the central socket. The Node hub has the same in
//! services/solora-fleet.ts.
//!
//!   hub:control { type: "diagnostics" }   → hub:diagnostics { report }: versions, uptime,
//!                                            storage, display counts. Never household rows.
//!   hub:control { type: "forget_device" } → drop that display's central login
//!   hub:control { type: "restart" }       → on a panel the hub lives inside the wall app,
//!                                            which central restarts with hub:command; logged here
//!   provision:update / flags:update       → for the displays, which apply and report themselves
//!
//! The family sees each of these in its activity feed (manufacturer:action, support.rs).

use crate::Hub;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Instant;

static STARTED: OnceLock<Instant> = OnceLock::new();

/// Called when the hub starts, for uptime.
pub fn mark_started() {
    let _ = STARTED.set(Instant::now());
}

/// `release-arch` the way central keys releases: android-aarch64, linux-x86_64…
pub fn platform() -> String {
    let os = if cfg!(target_os = "android") { "android" } else { std::env::consts::OS };
    format!("{os}-{}", std::env::consts::ARCH)
}

/// What hub:heartbeat carries besides counts, so the console can tell hubs apart.
pub fn identity(hub: &Hub) -> Value {
    json!({ "version": hub.config.app_version.clone().unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()), "platform": platform() })
}

fn diagnostics(hub: &Hub) -> Value {
    let (kiosks, online): (i64, i64) = hub
        .store
        .db()
        .query_row("SELECT count(*), coalesce(sum(is_online), 0) FROM kiosk_devices", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap_or((0, 0));
    let db_mb = std::fs::metadata(hub.config.data_dir.join("solora.db"))
        .map(|m| (m.len() as f64 / 1_048_576.0 * 10.0).round() / 10.0)
        .ok();
    let mut report = identity(hub);
    let r = report.as_object_mut().unwrap();
    r.insert("hub_core".into(), json!(env!("CARGO_PKG_VERSION")));
    r.insert("uptime_s".into(), json!(STARTED.get().map(|t| t.elapsed().as_secs()).unwrap_or(0)));
    r.insert("db_size_mb".into(), json!(db_mb));
    r.insert("kiosks".into(), json!(kiosks));
    r.insert("kiosks_online".into(), json!(online));
    r.insert("central_connected".into(), json!(hub.central.is_connected()));
    report
}

pub fn on_control(hub: &Hub, payload: &Value) {
    match payload.get("type").and_then(Value::as_str) {
        Some("diagnostics") => {
            let request_id = payload.get("request_id").cloned().unwrap_or(Value::Null);
            hub.central.emit("hub:diagnostics", &json!({ "request_id": request_id, "report": diagnostics(hub) }));
        }
        Some("forget_device") => {
            let id = payload.get("device_id").and_then(Value::as_str).unwrap_or_default();
            match crate::central::forget_device(hub, id) {
                Some(local) => println!("[fleet] Solora unpaired central device {id} (local display {local})"),
                None => println!("[fleet] Solora unpaired central device {id} (not one of ours)"),
            }
        }
        // The displays get hub:command restart in the same breath and restart
        // the app, and this hub with it.
        Some("restart") => println!("[fleet] restart requested by Solora; the wall app restarts itself"),
        other => eprintln!("[fleet] unknown hub:control {other:?}"),
    }
}

pub fn on_provision(payload: &Value) {
    println!(
        "[fleet] provisioning profile {} r{} ({}) sent to this hub's displays",
        payload.get("name").and_then(Value::as_str).unwrap_or("?"),
        payload.get("revision").and_then(Value::as_i64).unwrap_or(0),
        payload.get("mode").and_then(Value::as_str).unwrap_or("?"),
    );
}
