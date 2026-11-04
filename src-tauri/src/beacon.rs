//! The wall's Bluetooth beacon, so a phone can tell it's standing right here.
//!
//! The wall broadcasts a non-connectable BLE advertisement with the Solora
//! wall service UUID and, in manufacturer data, a 4-byte tag: the first 8 hex
//! digits of this display's device id. Phones (tauri-plugin-nearby-invite's
//! `watchWalls`) listen for the UUID, judge closeness from the signal strength
//! and report it to the hub over Wi-Fi with their own member token, so the
//! beacon carries nothing secret. Keep the UUID and company id in sync with
//! NearbyInvitePlugin.swift / NearbyInvitePlugin.kt.
//!
//! It also broadcasts an iBeacon (same UUID, the tag split into major and
//! minor): iPhones can only wake a closed app for iBeacons, through Core
//! Location region monitoring. The two don't fit in one 31-byte packet, so
//! they're two advertisements.
//!
//! Linux here (BlueZ over D-Bus); Android has its own in SystemPlugin.kt
//! (android_system.rs). Elsewhere, and on a box with no Bluetooth
//! adapter, `wall_beacon_start` returns an error the UI just logs.

/// 6C756D6F-7261-4E10-8000-696E76697465 — "lumora" + 4E10 + "invite", next to the invite service.
/// The pre-Solora name stays: phones already scan for this exact UUID.
#[cfg(target_os = "linux")]
const WALL_SERVICE: u128 = 0x6C756D6F_7261_4E10_8000_696E76697465;
/// Bluetooth SIG's id reserved for testing; fine for a private beacon.
#[cfg(target_os = "linux")]
const COMPANY_ID: u16 = 0xFFFF;
/// Apple's company id, which is what makes a packet an iBeacon.
#[cfg(target_os = "linux")]
const APPLE_ID: u16 = 0x004C;
/// iBeacon's calibrated power at 1 m (dBm).
#[cfg(target_os = "linux")]
const IBEACON_POWER: i8 = -59;

/// iBeacon manufacturer data: type 0x02, length 0x15, UUID, major, minor, power.
#[cfg(target_os = "linux")]
fn ibeacon_data(tag: [u8; 4]) -> Vec<u8> {
    let mut data = vec![0x02, 0x15];
    data.extend_from_slice(&WALL_SERVICE.to_be_bytes());
    data.extend_from_slice(&tag); // major = tag[0..2], minor = tag[2..4]
    data.push(IBEACON_POWER as u8);
    data
}

#[cfg(target_os = "linux")]
mod imp {
    use super::{ibeacon_data, APPLE_ID, COMPANY_ID, WALL_SERVICE};
    use bluer::adv::{Advertisement, AdvertisementHandle, Type};
    use std::collections::{BTreeMap, BTreeSet};
    use std::sync::Mutex;

    /// The live advertisements; dropping the handles (and the session) unregisters them.
    static ACTIVE: Mutex<Option<(bluer::Session, Vec<AdvertisementHandle>)>> = Mutex::new(None);

    pub async fn start(tag: [u8; 4]) -> Result<(), String> {
        let session = bluer::Session::new().await.map_err(|e| format!("Bluetooth isn't available: {e}"))?;
        let adapter = session.default_adapter().await.map_err(|e| format!("No Bluetooth adapter: {e}"))?;
        adapter.set_powered(true).await.map_err(|e| format!("Couldn't turn Bluetooth on: {e}"))?;

        let adv = Advertisement {
            advertisement_type: Type::Broadcast,
            service_uuids: BTreeSet::from([bluer::Uuid::from_u128(WALL_SERVICE)]),
            manufacturer_data: BTreeMap::from([(COMPANY_ID, tag.to_vec())]),
            discoverable: Some(false),
            ..Default::default()
        };
        let mut handles = vec![adapter.advertise(adv).await.map_err(|e| format!("Couldn't start the wall beacon: {e}"))?];

        let ibeacon = Advertisement {
            advertisement_type: Type::Broadcast,
            manufacturer_data: BTreeMap::from([(APPLE_ID, ibeacon_data(tag))]),
            discoverable: Some(false),
            ..Default::default()
        };
        // An adapter with one advertising slot can't do both; Android and open
        // iPhone apps still work from the first, so this one is best effort.
        match adapter.advertise(ibeacon).await {
            Ok(h) => handles.push(h),
            Err(e) => eprintln!("[beacon] iBeacon not started (iPhones won't wake in the background): {e}"),
        }
        *ACTIVE.lock().unwrap() = Some((session, handles));
        Ok(())
    }

    pub fn stop() {
        ACTIVE.lock().unwrap().take();
    }
}

/// "a1b2c3d4…" (a device id, dashes allowed) → its first 4 bytes.
pub(crate) fn parse_tag(device_id: &str) -> Option<[u8; 4]> {
    let hex: String = device_id.chars().filter(|c| c.is_ascii_hexdigit()).take(8).collect();
    if hex.len() < 8 {
        return None;
    }
    let mut tag = [0u8; 4];
    for (i, byte) in tag.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(tag)
}

/// Start (or restart) broadcasting this display's beacon.
#[cfg(not(target_os = "android"))]
#[tauri::command]
pub async fn wall_beacon_start(device_id: String) -> Result<(), String> {
    let tag = parse_tag(&device_id).ok_or("device id has no hex tag")?;
    #[cfg(target_os = "linux")]
    {
        imp::stop();
        imp::start(tag).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = tag;
        Err("The wall beacon needs Linux (BlueZ).".into())
    }
}

#[cfg(not(target_os = "android"))]
#[tauri::command]
pub fn wall_beacon_stop() {
    #[cfg(target_os = "linux")]
    imp::stop();
}

#[cfg(test)]
mod tests {
    use super::parse_tag;

    #[cfg(target_os = "linux")]
    #[test]
    fn ibeacon_layout() {
        let d = super::ibeacon_data([0x73, 0xc8, 0x90, 0xce]);
        assert_eq!(d.len(), 23);
        assert_eq!(&d[..4], &[0x02, 0x15, 0x6C, 0x75]);
        assert_eq!(&d[18..], &[0x73, 0xc8, 0x90, 0xce, 0xC5]);
    }

    #[test]
    fn tag_from_uuid() {
        assert_eq!(parse_tag("A1b2c3d4-0000-4000-8000-000000000000"), Some([0xa1, 0xb2, 0xc3, 0xd4]));
        assert_eq!(parse_tag("a1-b2"), None);
    }
}
