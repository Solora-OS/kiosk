//! Self-update for the Android wall display.
//!
//! The Tauri updater plugin has no Android backend, so this does its job:
//! download the APK central points at, check its minisign signature against
//! the same `plugins.updater.pubkey` the desktop build trusts, then hand it to
//! ApkInstallerPlugin.kt, which installs it with PackageInstaller. When Solora
//! is the device owner that install is silent; otherwise Android asks first.
//!
//! The lookup itself (GET /updates/android/aarch64/{current}) happens in
//! src/lib/hub.ts, like the desktop updater check.

use serde::Serialize;
use tauri::{AppHandle, Runtime};

/// What `apk_update_install` did. Keep in sync with `ApkInstallOutcome` in src/lib/hub.ts.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct InstallOutcome {
    /// "installing" (silent; Android replaces and restarts the app) or
    /// "needs_confirmation" (Android is showing its install prompt).
    pub status: String,
}

/// `{ target, arch }` for the update URL, e.g. android / aarch64.
#[derive(Debug, Serialize)]
pub struct UpdateTarget {
    target: &'static str,
    arch: &'static str,
}

#[tauri::command]
pub fn update_target() -> UpdateTarget {
    UpdateTarget { target: std::env::consts::OS, arch: std::env::consts::ARCH }
}

#[tauri::command]
pub async fn apk_update_install<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    signature: String,
) -> Result<InstallOutcome, String> {
    #[cfg(target_os = "android")]
    {
        android::install(app, url, signature).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, url, signature);
        Err("APK updates only run on Android".into())
    }
}

#[cfg(any(target_os = "android", test))]
fn base64_to_string(s: &str) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("bad base64: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "not UTF-8".to_string())
}

/// Same check as tauri-plugin-updater's verify_signature.
#[cfg(any(target_os = "android", test))]
fn verify(data: &[u8], signature: &str, pubkey: &str) -> Result<(), String> {
    use minisign_verify::{PublicKey, Signature};
    let key = PublicKey::decode(&base64_to_string(pubkey)?).map_err(|e| format!("bad update key: {e}"))?;
    let sig = Signature::decode(&base64_to_string(signature)?).map_err(|e| format!("bad signature: {e}"))?;
    key.verify(data, &sig, true).map_err(|_| "Update signature doesn't match — not installing".to_string())
}

#[cfg(test)]
mod tests {
    use super::verify;

    // Signed with a throwaway key by `tauri signer sign`, the same way
    // scripts/release-android.sh signs a real APK.
    const PAYLOAD: &[u8] = include_bytes!("apk_update_fixtures/payload.bin");
    const SIG: &str = include_str!("apk_update_fixtures/payload.bin.sig");
    const KEY: &str = include_str!("apk_update_fixtures/test-key.pub");

    #[test]
    fn accepts_a_tauri_signed_file() {
        assert_eq!(verify(PAYLOAD, SIG, KEY), Ok(()));
    }

    #[test]
    fn rejects_a_changed_file() {
        let mut tampered = PAYLOAD.to_vec();
        tampered[0] ^= 1;
        assert!(verify(&tampered, SIG, KEY).is_err());
    }

    #[test]
    fn rejects_another_key() {
        let real_key = serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json")).unwrap()
            ["plugins"]["updater"]["pubkey"].as_str().unwrap().to_string();
        assert!(verify(PAYLOAD, SIG, &real_key).is_err());
    }
}

#[cfg(target_os = "android")]
pub use android::init;

#[cfg(target_os = "android")]
mod android {
    use super::{verify, InstallOutcome};
    use serde::Serialize;
    use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
    use tauri::{AppHandle, Manager, Runtime};

    struct ApkInstaller<R: Runtime>(PluginHandle<R>);

    #[derive(Serialize)]
    struct InstallArgs {
        path: String,
    }

    pub fn init<R: Runtime>() -> TauriPlugin<R> {
        Builder::new("apk-installer")
            .setup(|app, api| {
                let handle = api.register_android_plugin("com.peakl.lumora_kiosk", "ApkInstallerPlugin")?;
                app.manage(ApkInstaller(handle));
                Ok(())
            })
            .build()
    }

    pub async fn install<R: Runtime>(app: AppHandle<R>, url: String, signature: String) -> Result<InstallOutcome, String> {
        if !url.starts_with("https://") {
            return Err("Update URL must be https".into());
        }
        let pubkey = app
            .config()
            .plugins
            .0
            .get("updater")
            .and_then(|u| u.get("pubkey"))
            .and_then(|k| k.as_str())
            .ok_or("No updater pubkey in tauri.conf.json")?
            .to_string();

        let bytes = tauri_plugin_http::reqwest::get(&url)
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Download failed: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("Download failed: {e}"))?;
        verify(&bytes, &signature, &pubkey)?;

        let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("updates");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let path = dir.join("solora-update.apk");
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

        app.state::<ApkInstaller<R>>()
            .0
            .run_mobile_plugin::<InstallOutcome>("install", InstallArgs { path: path.to_string_lossy().into_owned() })
            .map_err(|e| e.to_string())
    }
}
