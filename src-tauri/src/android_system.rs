//! The kiosk's system commands on Android. Same names and arguments as the
//! Linux ones in lib.rs (nmcli, timedatectl, wpctl, ...), so the frontend
//! doesn't care which it runs on; lib.rs registers these instead on Android.
//! The work happens in SystemPlugin.kt.

use serde::Serialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

struct System<R: Runtime>(Arc<PluginHandle<R>>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("solora-system")
        .setup(|app, api| {
            let handle = api.register_android_plugin("com.peakl.lumora_kiosk", "SystemPlugin")?;
            app.manage(System(Arc::new(handle)));
            Ok(())
        })
        .build()
}

/// Runs a SystemPlugin command off the async runtime (some wait on Wi-Fi) and
/// unwraps its `{ value }`.
async fn run<R: Runtime>(app: &AppHandle<R>, command: &'static str, args: impl Serialize + Send + 'static) -> Result<Value, String> {
    let handle = app.state::<System<R>>().0.clone();
    let out = tauri::async_runtime::spawn_blocking(move || handle.run_mobile_plugin::<Value>(command, args))
        .await
        .map_err(|e| e.to_string())?;
    match out {
        Ok(mut v) => Ok(v["value"].take()),
        Err(tauri::plugin::mobile::PluginInvokeError::InvokeRejected(r)) => Err(r.message.unwrap_or_else(|| format!("{command} failed"))),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn wifi_scan<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "wifiScan", ()).await
}

#[tauri::command]
pub async fn wifi_connect<R: Runtime>(app: AppHandle<R>, ssid: String, password: Option<String>) -> Result<Value, String> {
    run(&app, "wifiConnect", json!({ "ssid": ssid, "password": password })).await
}

#[tauri::command]
pub async fn wifi_status<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "wifiStatus", ()).await
}

#[tauri::command]
pub async fn locale_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "localeGet", ()).await
}

#[tauri::command]
pub async fn locale_set<R: Runtime>(app: AppHandle<R>, lang: String) -> Result<Value, String> {
    run(&app, "localeSet", json!({ "lang": lang })).await
}

#[tauri::command]
pub async fn timezone_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "timezoneGet", ()).await
}

#[tauri::command]
pub async fn timezone_set<R: Runtime>(app: AppHandle<R>, timezone: String) -> Result<Value, String> {
    run(&app, "timezoneSet", json!({ "timezone": timezone })).await
}

#[tauri::command]
pub async fn screen_orientation_set<R: Runtime>(app: AppHandle<R>, rotation: String) -> Result<Value, String> {
    run(&app, "orientationSet", json!({ "rotation": rotation })).await
}

#[tauri::command]
pub async fn system_volume_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "volumeGet", ()).await
}

#[tauri::command]
pub async fn system_volume_set<R: Runtime>(app: AppHandle<R>, volume: u8) -> Result<Value, String> {
    run(&app, "volumeSet", json!({ "volume": volume.min(100) })).await
}

#[tauri::command]
pub async fn system_mute_set<R: Runtime>(app: AppHandle<R>, muted: bool) -> Result<Value, String> {
    run(&app, "muteSet", json!({ "muted": muted })).await
}

#[tauri::command]
pub async fn system_brightness_get<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "brightnessGet", ()).await
}

#[tauri::command]
pub async fn system_brightness_set<R: Runtime>(app: AppHandle<R>, level: u8) -> Result<Value, String> {
    run(&app, "brightnessSet", json!({ "level": level })).await
}

#[tauri::command]
pub async fn system_display_sleep<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "displaySleep", ()).await
}

#[tauri::command]
pub async fn system_display_wake<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "displayWake", ()).await
}

#[tauri::command]
pub async fn system_power<R: Runtime>(app: AppHandle<R>, action: String) -> Result<Value, String> {
    run(&app, "power", json!({ "action": action })).await
}

#[tauri::command]
pub async fn wall_beacon_start<R: Runtime>(app: AppHandle<R>, device_id: String) -> Result<Value, String> {
    let tag = crate::beacon::parse_tag(&device_id).ok_or("device id has no hex tag")?;
    let hex: String = tag.iter().map(|b| format!("{b:02x}")).collect();
    run(&app, "beaconStart", json!({ "tag": hex })).await
}

#[tauri::command]
pub async fn wall_beacon_stop<R: Runtime>(app: AppHandle<R>) -> Result<Value, String> {
    run(&app, "beaconStop", ()).await
}
