//! The hub's link to Solora central: registration and the per-display
//! central tokens (lib/central-registry.ts, same central.json), and the live
//! socket (lib/central-socket-client.ts): heartbeats, relaying household
//! events, and the calls central sends the hub (relay.rs, support.rs).

use crate::socketio_client::{self, Emitter, Incoming};
use crate::Hub;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KioskCredentials {
    pub central_device_id: String,
    pub central_jwt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub hub_id: String,
    pub hub_token: String,
    pub hub_jwt: String,
    #[serde(default)]
    pub kiosks: Map<String, Value>,
}

impl Credentials {
    fn kiosk(&self, id: &str) -> Option<KioskCredentials> {
        serde_json::from_value(self.kiosks.get(id)?.clone()).ok()
    }
}

pub struct Central {
    pub api_url: String,
    pub socket_url: String,
    creds: RwLock<Option<Credentials>>,
    socket: Mutex<Option<Emitter>>,
}

const TIMEOUT: Duration = Duration::from_secs(5);

impl Central {
    pub fn new(api_url: &str, socket_url: &str) -> Self {
        Central {
            api_url: api_url.trim_end_matches('/').to_string(),
            socket_url: socket_url.trim_end_matches('/').to_string(),
            creds: RwLock::new(None),
            socket: Mutex::new(None),
        }
    }

    /// The hub's central JWT (sub = central hub id), once registered.
    pub fn hub_jwt(&self) -> Option<String> {
        self.creds.read().unwrap().as_ref().map(|c| c.hub_jwt.clone())
    }

    pub fn kiosk(&self, local_id: &str) -> Option<KioskCredentials> {
        self.creds.read().unwrap().as_ref()?.kiosk(local_id)
    }

    pub fn is_connected(&self) -> bool {
        self.socket.lock().unwrap().as_ref().is_some_and(Emitter::is_connected)
    }

    /// Emits on the central socket if it's connected (dropped otherwise, like socket.io-client).
    pub fn emit(&self, event: &str, payload: &Value) {
        if let Some(s) = self.socket.lock().unwrap().as_ref() {
            s.emit(event, payload);
        }
    }

    fn file(hub: &Hub) -> std::path::PathBuf {
        hub.store.dir.join("central.json")
    }

    /// central.json as it is on disk (what /central-identity and /connection-health read).
    pub fn read_file(hub: &Hub) -> Option<Credentials> {
        serde_json::from_str(&std::fs::read_to_string(Self::file(hub)).ok()?).ok()
    }

    fn save(hub: &Hub, creds: &Credentials) {
        if let Ok(s) = serde_json::to_string_pretty(creds) {
            let _ = std::fs::write(Self::file(hub), s);
        }
    }
}

/// `ensureCentralRegistration`: log in with stored credentials or register,
/// then register paired displays. Returns the hub JWT, or None when offline.
pub async fn ensure_registration(hub: &Hub) -> Option<String> {
    let central = &hub.central;
    let stored = Central::read_file(hub);
    let (hub_id, hub_token, hub_jwt) = if let Some(creds) = &stored {
        let res = hub
            .http
            .post(format!("{}/register/hub/login", central.api_url))
            .json(&json!({ "hub_id": creds.hub_id, "hub_token": creds.hub_token }))
            .timeout(TIMEOUT)
            .send()
            .await;
        match res {
            Ok(r) if r.status().is_success() => match r.json::<Value>().await.ok().and_then(|v| v["jwt"].as_str().map(str::to_string)) {
                Some(jwt) => {
                    println!("[central] Hub refreshed JWT  hub_id={}", creds.hub_id);
                    (creds.hub_id.clone(), creds.hub_token.clone(), jwt)
                }
                None => return cached(hub, creds.clone()),
            },
            other => {
                let why = other.map(|r| format!("Hub login failed: {}", r.status().as_u16())).unwrap_or_else(|e| e.to_string());
                eprintln!("[central] Could not refresh hub JWT — using cached: {why}");
                return cached(hub, creds.clone());
            }
        }
    } else {
        let res = hub
            .http
            .post(format!("{}/register/hub", central.api_url))
            .json(&json!({ "name": hub.config.hub_name, "owner_email": hub.config.hub_owner_email }))
            .timeout(TIMEOUT)
            .send()
            .await;
        let data = match res {
            Ok(r) if r.status().is_success() => r.json::<Value>().await.ok(),
            Ok(r) => {
                eprintln!("[central] Could not register with central API — running offline: Hub registration failed: {}", r.status().as_u16());
                None
            }
            Err(e) => {
                eprintln!("[central] Could not register with central API — running offline: {e}");
                None
            }
        }?;
        let text = |k: &str| data[k].as_str().map(str::to_string);
        let (id, token, jwt) = (text("hub_id")?, text("hub_token")?, text("jwt")?);
        println!("[central] Hub registered  hub_id={id}");
        (id, token, jwt)
    };
    let creds = Credentials { hub_id, hub_token, hub_jwt: hub_jwt.clone(), kiosks: stored.map(|c| c.kiosks).unwrap_or_default() };
    Central::save(hub, &creds);
    *central.creds.write().unwrap() = Some(creds);
    register_paired_kiosks(hub).await;
    Some(hub_jwt)
}

fn cached(hub: &Hub, creds: Credentials) -> Option<String> {
    let jwt = creds.hub_jwt.clone();
    *hub.central.creds.write().unwrap() = Some(creds);
    Some(jwt)
}

async fn register_kiosk(hub: &Hub, hub_jwt: &str, device_name: &str) -> Option<KioskCredentials> {
    let res = hub
        .http
        .post(format!("{}/register/kiosk", hub.central.api_url))
        .bearer_auth(hub_jwt)
        .json(&json!({ "device_name": device_name }))
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        eprintln!("[central] Kiosk registration failed  status={}", res.status().as_u16());
        return None;
    }
    let data: Value = res.json().await.ok()?;
    Some(KioskCredentials { central_device_id: data["device_id"].as_str()?.into(), central_jwt: data["jwt"].as_str()?.into() })
}

fn store_kiosk(hub: &Hub, local_id: &str, k: &KioskCredentials) {
    let mut guard = hub.central.creds.write().unwrap();
    if let Some(creds) = guard.as_mut() {
        creds.kiosks.insert(local_id.to_string(), serde_json::to_value(k).unwrap());
        Central::save(hub, creds);
    }
}

/// Drops the central login of the display central knows as `central_id`
/// (Solora unpaired it). It stays paired here and gets a fresh central identity
/// the next time it asks. Returns the local display id.
pub fn forget_device(hub: &Hub, central_id: &str) -> Option<String> {
    let mut guard = hub.central.creds.write().unwrap();
    let creds = guard.as_mut()?;
    let local = creds.kiosks.iter().find_map(|(local, k)| {
        (k.get("central_device_id").and_then(Value::as_str) == Some(central_id)).then(|| local.clone())
    })?;
    creds.kiosks.remove(&local);
    Central::save(hub, creds);
    Some(local)
}

async fn register_paired_kiosks(hub: &Hub) {
    let Some(jwt) = hub.central.hub_jwt() else { return };
    let paired: Vec<(String, String)> = {
        let db = hub.store.db();
        let mut stmt = match db.prepare("SELECT id, device_name FROM kiosk_devices WHERE household_id IS NOT NULL") {
            Ok(s) => s,
            Err(_) => return,
        };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
    };
    for (id, name) in paired {
        if hub.central.kiosk(&id).is_some() {
            continue;
        }
        if let Some(k) = register_kiosk(hub, &jwt, &name).await {
            println!("[central] Kiosk registered  local={id}  central={}", k.central_device_id);
            store_kiosk(hub, &id, &k);
        }
    }
}

/// `registerKioskWithCentral`: a display's central JWT, registering it now if needed.
pub async fn register_kiosk_on_demand(hub: &Hub, local_id: &str) -> Option<String> {
    let jwt = hub.central.hub_jwt()?;
    if let Some(k) = hub.central.kiosk(local_id) {
        return Some(k.central_jwt);
    }
    let name: String = hub
        .store
        .db()
        .query_row("SELECT device_name FROM kiosk_devices WHERE id = ?", [local_id], |r| r.get(0))
        .ok()?;
    let k = register_kiosk(hub, &jwt, &name).await?;
    println!("[central] Kiosk registered on-demand  local={local_id}  central={}", k.central_device_id);
    store_kiosk(hub, local_id, &k);
    Some(k.central_jwt)
}

/// Registers (retrying until central answers, so a hub that first boots
/// offline still links once it gets Wi-Fi), then connects.
pub async fn link(hub: Arc<Hub>) {
    let mut wait = Duration::from_secs(10);
    while ensure_registration(&hub).await.is_none() {
        eprintln!("[central] Retrying registration in {}s", wait.as_secs());
        tokio::time::sleep(wait).await;
        wait = (wait * 2).min(Duration::from_secs(300));
    }
    connect(hub).await;
}

// ---- The live socket ----------------------------------------------------------

/// Heartbeat for the fleet console: which paired displays are online.
async fn rest_heartbeat(hub: &Hub, hub_jwt: &str) {
    let kiosks: Vec<(String, i64, Option<i64>)> = {
        let db = hub.store.db();
        let Ok(mut stmt) = db.prepare("SELECT id, is_online, wifi_signal FROM kiosk_devices WHERE household_id IS NOT NULL") else { return };
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map(|rows| rows.flatten().collect()).unwrap_or_default()
    };
    let devices: Vec<Value> = kiosks
        .into_iter()
        .filter_map(|(id, online, wifi)| hub.central.kiosk(&id).map(|k| json!({ "id": k.central_device_id, "is_online": online == 1, "wifi_signal": wifi })))
        .collect();
    let res = hub
        .http
        .post(format!("{}/devices/heartbeat", hub.central.api_url))
        .bearer_auth(hub_jwt)
        .json(&json!({ "devices": devices }))
        .timeout(TIMEOUT)
        .send()
        .await;
    if let Err(e) = res {
        eprintln!("[central] heartbeat failed: {e}");
    }
}

/// `connectHubToCentral`: connects (and keeps reconnecting) as this hub.
async fn connect(hub: Arc<Hub>) {
    let auth = hub.clone();
    let (emitter, mut incoming) =
        socketio_client::connect(&hub.central.socket_url, move || json!({ "token": auth.central.hub_jwt().unwrap_or_default() }));
    *hub.central.socket.lock().unwrap() = Some(emitter);

    // Every 60 seconds, so the fleet console shows the hub online.
    let beat = hub.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await;
        loop {
            tick.tick().await;
            if let Some(jwt) = beat.central.hub_jwt().filter(|_| beat.central.is_connected()) {
                rest_heartbeat(&beat, &jwt).await;
            }
        }
    });

    // The hub JWT lasts HUB_JWT_TTL (30 days) and a panel can run far longer
    // between reboots: log in again daily, and whenever central refuses it.
    let daily = hub.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 60 * 60));
        tick.tick().await;
        loop {
            tick.tick().await;
            ensure_registration(&daily).await;
        }
    });
    let mut last_refresh: Option<std::time::Instant> = None;

    while let Some(event) = incoming.recv().await {
        match event {
            Incoming::Connected => {
                println!("[central-socket] Hub connected to central socket  url={}", hub.central.socket_url);
                let mut beat = json!({ "kiosk_count": 0, "online_count": 0 });
                beat.as_object_mut().unwrap().extend(crate::fleet::identity(&hub).as_object().unwrap().clone());
                hub.central.emit("hub:heartbeat", &beat);
                if let Some(jwt) = hub.central.hub_jwt() {
                    rest_heartbeat(&hub, &jwt).await;
                }
                // Anything Solora did while this hub was offline.
                let h = hub.clone();
                tokio::spawn(async move { crate::support::sync_actions(&h).await });
            }
            Incoming::Rejected(why) => {
                eprintln!("[central-socket] Central refused the hub JWT: {why}");
                // At most every 5 minutes, so a revoked hub doesn't hammer the login.
                if last_refresh.is_none_or(|t| t.elapsed() > Duration::from_secs(300)) {
                    last_refresh = Some(std::time::Instant::now());
                    let h = hub.clone();
                    tokio::spawn(async move { ensure_registration(&h).await });
                }
            }
            Incoming::Disconnected(reason) => eprintln!("[central-socket] Hub disconnected from central socket: {reason}"),
            Incoming::Event(name, payload) => match name.as_str() {
                "hub:rpc" => drop(tokio::spawn(crate::relay::on_rpc(hub.clone(), payload))),
                "hub:invite-rpc" => drop(tokio::spawn(crate::relay::on_invite_rpc(hub.clone(), payload))),
                // What Solora does to this hub, live, so the family sees it in Privacy & support.
                "manufacturer:action" => crate::support::record_action(&hub, &payload),
                "support:request" => crate::support::on_support_request(&hub, &payload),
                // The Solora console's fleet controls (fleet.rs).
                "hub:control" => crate::fleet::on_control(&hub, &payload),
                "provision:update" => crate::fleet::on_provision(&payload),
                _ => {}
            },
        }
    }
}

/// `relayEvent`: a household event, re-sent through central to apps off the LAN.
pub fn relay(hub: &Arc<Hub>, event: &str, payload: &Value) {
    hub.central.emit("hub:relay", &json!({ "event": event, "payload": payload }));
}
