//! Bakes the Google / Microsoft OAuth client into the hub. The in-app hub
//! (Android panel, desktop kiosk) has no .env at runtime, so without this the
//! calendar code exchange has no client id or secret. Installed-app OAuth
//! secrets aren't confidential (Google and Microsoft both say so), so shipping
//! them in the binary is fine. A runtime env var still wins (routes/providers.rs).
//!
//! Source: the build's env first, then kiosk/.env.

use std::path::Path;

const KEYS: &[&str] = &[
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET",
    "MICROSOFT_CLIENT_ID", "MICROSOFT_TENANT_ID",
];

fn main() {
    let dotenv = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    println!("cargo:rerun-if-changed={}", dotenv.display());
    let file = std::fs::read_to_string(&dotenv).unwrap_or_default();
    let from_file = |key: &str| {
        file.lines()
            .filter_map(|l| l.trim().split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map(|(_, v)| v.trim().trim_matches('"').trim_matches('\'').to_string())
    };
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
        let value = std::env::var(key).ok().filter(|v| !v.is_empty()).or_else(|| from_file(key)).unwrap_or_default();
        println!("cargo:rustc-env=SOLORA_BUILD_{key}={value}");
    }
}
