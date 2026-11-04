//! The household hub, in-process in the kiosk app (hub/, `solora-hub`): on the
//! wall panel (Android), Linux hubs, and a Mac running the app in development.
//!
//! It serves the family's API on port 4000 like the Node hub did, so this web
//! view, phones on the Wi-Fi and central all reach it the same way.
//!   Android: data in the app's data directory under `hub/`; SoloraHubService
//!            keeps the process serving while the screen sleeps.
//!   Linux, macOS: data in `~/.solora`, where the Node hub keeps it, so an existing
//!            hub carries on with its family, phones and central link. The Node
//!            hub's variables (SOLORA_PORT, CENTRAL_API_URL, HUB_NAME, ...) still
//!            apply; SOLORA_HUB=off leaves the hub to a separate server.

use tauri::{AppHandle, Runtime};

/// Central for the hub; the build can point it elsewhere (scripts/android-dev.sh).
const CENTRAL: &str = match option_env!("SOLORA_HUB_CENTRAL_URL") {
    Some(url) => url,
    None => "https://179-236-254-241.sslip.io",
};
/// The panel's hub name and owner email; the contract suite's HUB_DEVICE run sets its own.
#[cfg(target_os = "android")]
const NAME: &str = match option_env!("SOLORA_HUB_NAME") {
    Some(name) => name,
    None => "Solora Hub",
};
#[cfg(target_os = "android")]
const OWNER_EMAIL: &str = match option_env!("SOLORA_HUB_OWNER_EMAIL") {
    Some(email) => email,
    None => "admin@solora.local",
};

#[cfg(target_os = "android")]
fn config<R: Runtime>(app: &AppHandle<R>) -> Option<solora_hub::Config> {
    use tauri::Manager;
    let data_dir = match app.path().app_data_dir() {
        Ok(d) => d.join("hub"),
        Err(e) => {
            eprintln!("[hub] no data directory, not starting: {e}");
            return None;
        }
    };
    Some(solora_hub::Config {
        port: 4000,
        data_dir,
        central_api_url: CENTRAL.into(),
        central_socket_url: CENTRAL.into(),
        hub_name: NAME.into(),
        hub_owner_email: OWNER_EMAIL.into(),
    })
}

#[cfg(not(target_os = "android"))]
fn config<R: Runtime>(_app: &AppHandle<R>) -> Option<solora_hub::Config> {
    if std::env::var("SOLORA_HUB").is_ok_and(|v| v == "off") {
        println!("[hub] SOLORA_HUB=off: using a separate hub server");
        return None;
    }
    let mut config = solora_hub::Config::from_env();
    if std::env::var("CENTRAL_API_URL").is_err() {
        config.central_api_url = CENTRAL.into();
    }
    if std::env::var("CENTRAL_SOCKET_URL").is_err() {
        config.central_socket_url = CENTRAL.into();
    }
    Some(config)
}

pub fn start<R: Runtime>(app: &AppHandle<R>) {
    let Some(config) = config(app) else { return };
    tauri::async_runtime::spawn(async move {
        // Port 4000 taken (an old Node hub still running) ends up here; the
        // web view keeps using whichever hub answers.
        if let Err(e) = solora_hub::run(config, std::future::pending()).await {
            eprintln!("[hub] stopped: {e}");
        }
    });
}
