//! Publishes this hub as _solora._tcp on the LAN so the mobile app can find it
//! without knowing its IP (lib/mdns-advertise.ts).
//!
//! TXT records: hub_id (hub-identity.json), name, claimed. "claimed" follows
//! the households table, checked every 30 s and re-published when it changes;
//! GET /hub/info is the real source of truth once a phone picks a hub.
//!
//! The instance name carries the start of the hub id ("Solora Hub 3F2A"): two
//! hubs on one Wi-Fi, as during a move, would otherwise share one name and
//! answer for each other. On Android, receiving the queries needs the app's
//! Wi-Fi multicast lock (SystemPlugin / SoloraHubService).

use crate::Hub;
use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::sync::Arc;
use std::time::Duration;

const SERVICE_TYPE: &str = "_solora._tcp.local.";
/// Phones from before the rename browse _lumora._tcp; keep answering them too.
const LEGACY_SERVICE_TYPE: &str = "_lumora._tcp.local.";

fn service(hub: &Hub, service_type: &str, claimed: bool) -> Option<ServiceInfo> {
    let identity = hub.store.identity();
    let short: String = identity.id.chars().filter(char::is_ascii_alphanumeric).take(4).collect::<String>().to_uppercase();
    let instance = format!("{} {short}", identity.name);
    let host = format!("solora-{}.local.", short.to_lowercase());
    let txt = [("hub_id", identity.id.as_str()), ("name", identity.name.as_str()), ("claimed", if claimed { "1" } else { "0" })];
    ServiceInfo::new(service_type, &instance, &host, "", hub.config.port, &txt[..]).ok().map(ServiceInfo::enable_addr_auto)
}

/// Starts advertising (off with SOLORA_MDNS=off, as for the contract suite's hubs).
pub fn start(hub: Arc<Hub>) {
    if std::env::var("SOLORA_MDNS").is_ok_and(|v| v == "off") {
        return;
    }
    let daemon = match ServiceDaemon::new() {
        Ok(d) => d,
        Err(e) => {
            eprintln!("[mdns] not advertising: {e}");
            return;
        }
    };
    let mut claimed = hub.store.households() > 0;
    let Some(info) = service(&hub, SERVICE_TYPE, claimed) else { return };
    let fullname = info.get_fullname().to_string();
    if let Err(e) = daemon.register(info) {
        eprintln!("[mdns] not advertising: {e}");
        return;
    }
    if let Some(legacy) = service(&hub, LEGACY_SERVICE_TYPE, claimed) {
        let _ = daemon.register(legacy);
    }
    let identity = hub.store.identity();
    println!("[mdns] Advertising _solora._tcp as \"{fullname}\" (hub_id={})", identity.id);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await;
        loop {
            tick.tick().await;
            let now = hub.store.households() > 0;
            if now == claimed {
                continue;
            }
            claimed = now;
            // Registering the same name again replaces its TXT record.
            for service_type in [SERVICE_TYPE, LEGACY_SERVICE_TYPE] {
                if let Some(info) = service(&hub, service_type, claimed) {
                    let _ = daemon.register(info);
                }
            }
        }
    });
}
