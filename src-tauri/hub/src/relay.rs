//! Calls that reach the hub through central, encrypted end to end:
//!
//! - `hub:rpc` (services/remote-rpc.ts): a family phone off the home network.
//!   AES-256-GCM under the household's remoteKey; the path must be on the
//!   allowlist, and the call runs against this hub's own API as that member.
//! - `hub:invite-rpc` (services/invite-relay.ts): someone joining from outside
//!   the Wi-Fi. AES-256-GCM under a key from ECDH (P-256) with this hub's
//!   invite key and HKDF bound to the invite; only the invite routes, and only
//!   for the invite central routed the call by.
//!
//! Both answer with `hub:rpc:response { correlation_id, ok, iv, ciphertext | error }`.

use crate::routes::auth::remote_key;
use crate::{tokens, Hub};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Wire constant shared with every phone and the Node hub. It predates the Solora
/// name; changing it breaks invites between versions.
const INVITE_LABEL: &str = "lumora-invite";
use std::sync::{Arc, OnceLock};
use std::time::Duration;

// ---- AES-256-GCM, tag appended (what WebCrypto and Node produce) ---------------

fn open(key: &[u8; 32], iv_b64: &str, ciphertext_b64: &str) -> Option<Value> {
    let iv = B64.decode(iv_b64).ok()?;
    if iv.len() != 12 {
        return None;
    }
    let ct = B64.decode(ciphertext_b64).ok()?;
    let plain = Aes256Gcm::new(key.into()).decrypt(Nonce::from_slice(&iv), ct.as_slice()).ok()?;
    serde_json::from_slice(&plain).ok()
}

fn seal(key: &[u8; 32], data: &Value) -> Value {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(&iv), data.to_string().as_bytes()).expect("AES-GCM encryption can't fail");
    json!({ "iv": B64.encode(iv), "ciphertext": B64.encode(ct) })
}

fn respond(hub: &Hub, correlation_id: &Value, ok: Result<Value, &str>) {
    let mut msg = json!({ "correlation_id": correlation_id });
    match ok {
        Ok(sealed) => {
            msg["ok"] = json!(true);
            if let (Value::Object(m), Value::Object(s)) = (&mut msg, sealed) {
                m.extend(s);
            }
        }
        Err(error) => {
            msg["ok"] = json!(false);
            msg["error"] = json!(error);
        }
    }
    hub.central.emit("hub:rpc:response", &msg);
}

/// A call against this hub's own API, as the remote caller.
async fn local(hub: &Hub, method: &str, path: &str, body: Option<&Value>, bearer: Option<&str>) -> Option<Value> {
    let url = format!("http://127.0.0.1:{}/api/v1{path}", hub.config.port);
    let method = reqwest::Method::from_bytes(method.to_uppercase().as_bytes()).ok()?;
    let mut req = hub.http.request(method, url).timeout(Duration::from_secs(12)).header("Content-Type", "application/json");
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    if let Some(body) = body {
        req = req.body(body.to_string());
    }
    let res = req.send().await.ok()?;
    let status = res.status().as_u16();
    let body = res.json::<Value>().await.unwrap_or(Value::Null);
    Some(json!({ "status": status, "body": body }))
}

// ---- hub:rpc --------------------------------------------------------------------

/// remote-rpc.ts RELAY_ALLOWLIST: the app's own API, nothing else.
fn allowed(path: &str) -> bool {
    const ROOTS: &[&str] = &[
        "snapshot", "households", "members", "calendars", "events", "chores", "lists", "list_items", "meals",
        "notifications", "photos", "invites", "auth/me", "kiosk-devices", "rewards", "away", "home",
        "calendar-links", "ics-link", "seasons", "summer",
    ];
    let Some(rest) = path.strip_prefix('/') else { return false };
    ROOTS.iter().any(|root| rest == *root || rest.strip_prefix(root).is_some_and(|after| after.starts_with('/')))
}

pub async fn on_rpc(hub: Arc<Hub>, envelope: Value) {
    let id = envelope.get("correlation_id").cloned().unwrap_or(Value::Null);
    let key = remote_key(&hub);
    let text = |k: &str| envelope.get(k).and_then(Value::as_str).unwrap_or("");
    let Some(payload) = open(&key, text("iv"), text("encrypted_payload")) else {
        eprintln!("[remote-rpc] decrypt failed");
        return respond(&hub, &id, Err("Decryption failed"));
    };
    let field = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let (method, path) = (field("method"), field("path"));
    if !allowed(&path) {
        eprintln!("[remote-rpc] blocked path: {path}");
        return respond(&hub, &id, Err("Path not allowed"));
    }
    let token = tokens::sign(
        hub.store.secret(),
        json!({ "sub": field("userId"), "householdId": field("householdId"), "role": "member", "email": "" }),
        "30s",
    );
    match local(&hub, &method, &path, payload.get("body"), Some(&token)).await {
        Some(result) => {
            println!("[remote-rpc] {method} {path} → {}", result["status"]);
            respond(&hub, &id, Ok(seal(&key, &result)))
        }
        None => respond(&hub, &id, Err("Hub internal error")),
    }
}

// ---- Invites through central ---------------------------------------------------------

/// This hub's long-lived P-256 key for invite claims (invite-ecdh.key, hex), made on first use.
fn invite_key(hub: &Hub) -> &'static p256::SecretKey {
    static KEY: OnceLock<p256::SecretKey> = OnceLock::new();
    KEY.get_or_init(|| {
        let path = hub.store.dir.join("invite-ecdh.key");
        if let Some(key) = std::fs::read_to_string(&path).ok().and_then(|h| hex::decode(h.trim()).ok()).and_then(|b| p256::SecretKey::from_slice(&b).ok()) {
            return key;
        }
        let key = p256::SecretKey::random(&mut rand::thread_rng());
        let _ = std::fs::write(&path, hex::encode(key.to_bytes()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        key
    })
}

/// The hub's invite public key: uncompressed point, base64.
pub fn invite_public_key(hub: &Hub) -> String {
    B64.encode(invite_key(hub).public_key().to_encoded_point(false).as_bytes())
}

/// The routing key central knows an invite by: never the code itself.
pub fn invite_lookup(token_or_code: &str) -> String {
    hex::encode(Sha256::digest(format!("{INVITE_LABEL}:{}", token_or_code.trim().to_uppercase()).as_bytes()))
}

/// AES key shared with the app that sent `client_pub`, bound to the invite it asked about.
fn invite_shared_key(hub: &Hub, client_pub: &str, lookup: &str) -> Option<[u8; 32]> {
    derive_invite_key(invite_key(hub), client_pub, lookup)
}

/// ECDH (P-256, x coordinate) then HKDF-SHA256(salt INVITE_LABEL, info lookup), as Node's
/// `computeSecret` + `hkdfSync` and the app's WebCrypto do.
fn derive_invite_key(ours: &p256::SecretKey, client_pub: &str, lookup: &str) -> Option<[u8; 32]> {
    let theirs = p256::PublicKey::from_sec1_bytes(&B64.decode(client_pub).ok()?).ok()?;
    let shared = p256::ecdh::diffie_hellman(ours.to_nonzero_scalar(), theirs.as_affine());
    let mut out = [0u8; 32];
    hkdf::Hkdf::<Sha256>::new(Some(INVITE_LABEL.as_bytes()), shared.raw_secret_bytes()).expand(lookup.as_bytes(), &mut out).ok()?;
    Some(out)
}

async fn invite_call(hub: &Hub, method: &str, lookup: &str, body: Option<Value>) {
    let Some(jwt) = hub.central.hub_jwt() else { return }; // offline install: LAN joins still work
    let mut req = hub
        .http
        .request(reqwest::Method::from_bytes(method.as_bytes()).unwrap(), format!("{}/invites/{lookup}", hub.central.api_url))
        .bearer_auth(jwt)
        .timeout(Duration::from_secs(8));
    if let Some(b) = body {
        req = req.json(&b);
    }
    match req.send().await {
        Ok(r) if !r.status().is_success() => eprintln!("[invite-relay] {method} invite at central failed: {}", r.status().as_u16()),
        Err(e) => eprintln!("[invite-relay] {method} invite at central failed: {e}"),
        _ => {}
    }
}

/// Lets an invite be found and claimed through central. Fire and forget.
pub fn register_remote_invite(hub: &Arc<Hub>, code: &str, token: &str, expires_at: &str) {
    let body = json!({ "hub_pub": invite_public_key(hub), "expires_at": expires_at });
    for key in [code, token] {
        let (hub, lookup, body) = (hub.clone(), invite_lookup(key), body.clone());
        tokio::spawn(async move { invite_call(&hub, "PUT", &lookup, Some(body)).await });
    }
}

/// Standing codes outlive any one registration at central: register them again at every boot.
pub fn register_reusable_invites(hub: &Arc<Hub>) {
    let rows = crate::db::all(&hub.store.db(), "SELECT code, token, expires_at FROM invites WHERE reusable = 1", crate::p![]);
    for r in &rows {
        register_remote_invite(hub, &crate::db::s(r, "code"), &crate::db::s(r, "token"), &crate::db::s(r, "expires_at"));
    }
}

/// Stops routing a claimed or revoked invite. Fire and forget.
pub fn unregister_remote_invite(hub: &Arc<Hub>, code: &str, token: &str) {
    for key in [code, token] {
        let (hub, lookup) = (hub.clone(), invite_lookup(key));
        tokio::spawn(async move { invite_call(&hub, "DELETE", &lookup, None).await });
    }
}

/// One remote invite call, only for the invite central routed it by.
async fn invite_handle(hub: &Hub, payload: &Value, lookup: &str) -> Option<Value> {
    let key = payload.get("key").and_then(Value::as_str).unwrap_or("");
    let op = payload.get("op").and_then(Value::as_str).unwrap_or("");
    // A tap ticket is routed by the ticket alone; its ".1234" check rides along.
    if invite_lookup(key.split('.').next().unwrap_or("")) != lookup {
        return Some(json!({ "status": 403, "body": { "error": "Invite mismatch." } }));
    }
    let encoded: String = url_encode(key);
    let found = local(hub, "GET", &format!("/invites/{encoded}"), None, None).await?;
    if op == "lookup" || found["status"] != json!(200) {
        return Some(found);
    }
    let body = payload.get("body").cloned().unwrap_or(json!({}));
    if body.get("token") != found["body"].get("token") {
        return Some(json!({ "status": 403, "body": { "error": "Invite mismatch." } }));
    }
    local(hub, "POST", if op == "claim" { "/invites/claim" } else { "/invites/claim-device" }, Some(&body), None).await
}

/// encodeURIComponent.
fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

pub async fn on_invite_rpc(hub: Arc<Hub>, envelope: Value) {
    let id = envelope.get("correlation_id").cloned().unwrap_or(Value::Null);
    let text = |k: &str| envelope.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let lookup = text("lookup");
    let opened = invite_shared_key(&hub, &text("client_pub"), &lookup).and_then(|key| open(&key, &text("iv"), &text("encrypted_payload")).map(|p| (key, p)));
    let Some((key, payload)) = opened else {
        eprintln!("[invite-relay] decrypt failed");
        return respond(&hub, &id, Err("Decryption failed"));
    };
    match invite_handle(&hub, &payload, &lookup).await {
        Some(result) => {
            println!("[invite-relay] {} → {}", payload["op"].as_str().unwrap_or("?"), result["status"]);
            respond(&hub, &id, Ok(seal(&key, &result)))
        }
        None => respond(&hub, &id, Err("Hub internal error")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlist_matches_remote_rpc() {
        for ok in ["/members", "/members/abc", "/auth/me", "/lists/1/items", "/ics-link", "/kiosk-devices/x"] {
            assert!(allowed(ok), "{ok}");
        }
        for no in ["/transfer/start", "/auth/session", "/membersx", "members", "/support/grants", "/kiosk/register"] {
            assert!(!allowed(no), "{no}");
        }
    }

    #[test]
    fn seal_then_open() {
        let key = [7u8; 32];
        let sealed = seal(&key, &json!({ "status": 200 }));
        assert_eq!(open(&key, sealed["iv"].as_str().unwrap(), sealed["ciphertext"].as_str().unwrap()), Some(json!({ "status": 200 })));
        assert_eq!(open(&[8u8; 32], sealed["iv"].as_str().unwrap(), sealed["ciphertext"].as_str().unwrap()), None);
    }

    /// Generated by Node's crypto (createECDH + hkdfSync), the hub this replaces.
    #[test]
    fn invite_key_matches_node() {
        let hub = p256::SecretKey::from_slice(&hex::decode("ab16696e41bfd4c9c639216b793a2df744f3203edacbccc105c74d1f0029cc45").unwrap()).unwrap();
        assert_eq!(
            B64.encode(hub.public_key().to_encoded_point(false).as_bytes()),
            "BAmB3egDAihlZBraW4JxDDcMRxHSf0O30/UkVb0B5Gir3e1nDjRGE8kM/72RKrCfs/muqBU00HSwo4AtRlPi6Is="
        );
        let lookup = invite_lookup("abc-234");
        assert_eq!(lookup, "5b6b4cf18f0a4cc5b145cda728f1f39d3f9fda0bc960f885da71ce86de2be4a0");
        let key = derive_invite_key(&hub, "BIgnN9CxmHo56E25FHGzjroAY7BFfvUmhzphuDaSGVnH9Cl2FRk8ccwyZ+NMAoBISaBoWT9C9S/Tk7UIreSNFtw=", &lookup).unwrap();
        assert_eq!(hex::encode(key), "c7d6da96cabbc6ea5f785668c53e9b1a48e1e2d581e29e5382260317af777dac");
    }

    #[test]
    fn lookup_is_case_insensitive() {
        assert_eq!(invite_lookup(" abc-123 "), invite_lookup("ABC-123"));
        assert_eq!(invite_lookup("ABC-123").len(), 64);
    }
}
