//! Moving a household from one hub to another (services/hub-transfer.ts,
//! routes/transfer.ts), so a new or replacement hub doesn't start empty.
//!
//!   Old hub: an admin starts a move and gets a one-time code (30 min).
//!   New hub: its own screen, before setup, sends the code to POST /pull. It
//!            finds the old hub on the LAN (or uses the address given),
//!            downloads the household and its photos, and links its display.
//!
//! Everything that crosses the network is AES-256-GCM under a key derived from
//! the code with scrypt; calendar tokens are decrypted with the old hub's
//! secret and re-encrypted with the new one's.

use crate::auth::User;
use crate::db;
use crate::http::{error, no_content, ok, Body, Peer};
use crate::routes::providers::{decrypt_token, encrypt_token};
use crate::{p, Hub};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use rand::RngCore;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

const TRANSFER_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_FAILED_TRIES: u32 = 10;
/// Household tables in the order rows can be inserted (parents before children).
const TABLES: [&str; 19] = [
    "households", "users", "members", "calendars", "events", "chores", "lists", "list_items",
    "meals", "notifications", "notification_states", "photos", "calendar_providers",
    "calendar_provider_mappings", "calendar_excluded_events", "activity_logs",
    "chore_completions", "rewards", "redemptions",
];
const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/start", post(start))
        .route("/export", get(export))
        .route("/photo/{filename}", get(photo))
        .route("/finish", post(finish))
        .route("/pull", post(pull))
}

/// "ab3d efgh" or "AB3D-EFGH" → "AB3D-EFGH".
fn normalize(input: &str) -> String {
    let raw: String = input.to_uppercase().chars().filter(|c| c.is_ascii_alphanumeric()).collect();
    if raw.len() == 8 { format!("{}-{}", &raw[..4], &raw[4..]) } else { raw }
}

fn new_code() -> String {
    let mut bytes = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut bytes);
    let raw: String = bytes.iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect();
    format!("{}-{}", &raw[..4], &raw[4..])
}

/// scrypt makes guessing the code from captured traffic slow (Node's scryptSync defaults: N=2^14, r=8, p=1).
fn key_for(code: &str) -> [u8; 32] {
    static CACHE: OnceLock<Mutex<HashMap<String, [u8; 32]>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(k) = cache.lock().unwrap().get(code) {
        return *k;
    }
    let mut key = [0u8; 32];
    scrypt::scrypt(code.as_bytes(), b"solora-hub-transfer", &scrypt::Params::new(14, 8, 1, 32).unwrap(), &mut key).expect("scrypt params are valid");
    cache.lock().unwrap().insert(code.to_string(), key);
    key
}

/// iv (12) ‖ ciphertext ‖ tag (16)
fn seal(code: &str, plain: &[u8]) -> Vec<u8> {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = Aes256Gcm::new(&key_for(code).into()).encrypt(Nonce::from_slice(&iv), plain).expect("AES-GCM can't fail");
    [&iv[..], &ct].concat()
}

fn open(code: &str, sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 28 {
        return None;
    }
    Aes256Gcm::new(&key_for(code).into()).decrypt(Nonce::from_slice(&sealed[..12]), &sealed[12..]).ok()
}

struct Pending {
    code: String,
    household_id: String,
    expires_at: Instant,
    failed_tries: u32,
}

fn pending() -> &'static Mutex<Option<Pending>> {
    static P: OnceLock<Mutex<Option<Pending>>> = OnceLock::new();
    P.get_or_init(Default::default)
}

/// The household an open move is for, if `input` is its code. Too many wrong codes cancel the move.
fn household_for_code(input: Option<&str>) -> Option<(String, String)> {
    let mut slot = pending().lock().unwrap();
    let p = slot.as_mut()?;
    if Instant::now() > p.expires_at {
        *slot = None;
        return None;
    }
    let given = normalize(input.unwrap_or(""));
    let matches = given.len() == p.code.len() && given.bytes().zip(p.code.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if matches {
        return Some((p.code.clone(), p.household_id.clone()));
    }
    p.failed_tries += 1;
    if p.failed_tries >= MAX_FAILED_TRIES {
        *slot = None;
    }
    None
}

fn code_from(headers: &HeaderMap) -> Option<(String, String)> {
    household_for_code(headers.get("x-transfer-code").and_then(|v| v.to_str().ok()))
}

fn octets(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], bytes).into_response()
}

async fn start(State(hub): State<Arc<Hub>>, user: User) -> Response {
    // requireAdmin
    let role = db::one(&hub.store.db(), "SELECT role FROM members WHERE user_id = ? AND household_id = ?", p![user.sub, user.household_id]);
    if role.is_none_or(|r| db::s(&r, "role") != "admin") {
        return error(403, "Admin access required.");
    }
    let code = new_code();
    let expires = chrono::Utc::now() + chrono::Duration::from_std(TRANSFER_TTL).unwrap();
    *pending().lock().unwrap() = Some(Pending { code: code.clone(), household_id: user.household_id.clone().unwrap_or_default(), expires_at: Instant::now() + TRANSFER_TTL, failed_tries: 0 });
    ok(json!({ "code": code, "expiresAt": expires.to_rfc3339_opts(chrono::SecondsFormat::Millis, true) }))
}

/// Every row that belongs to the household, plus the photo files to fetch.
fn export_household(hub: &Hub, household: &str) -> Value {
    let db_ = hub.store.db();
    let mut tables = Map::new();
    for table in TABLES {
        let sql = match table {
            "households" => "SELECT * FROM households WHERE id = ?".to_string(),
            "list_items" => "SELECT * FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE household_id = ?)".into(),
            "notification_states" => "SELECT * FROM notification_states WHERE notification_id IN (SELECT id FROM notifications WHERE household_id = ?)".into(),
            t => format!("SELECT * FROM {t} WHERE household_id = ?"),
        };
        let mut rows: Vec<Value> = db::all(&db_, &sql, p![household]).into_iter().map(Value::Object).collect();
        if table == "calendar_providers" {
            for r in rows.iter_mut() {
                let access = decrypt_token(hub, r["access_token"].as_str().unwrap_or(""));
                r["access_token"] = json!(access);
                let refresh = r["refresh_token"].as_str().map(|t| decrypt_token(hub, t));
                r["refresh_token"] = json!(refresh);
            }
        }
        tables.insert(table.into(), Value::Array(rows));
    }
    let photos: Vec<Value> = tables["photos"].as_array().unwrap().iter().map(|p| json!(db::js_string(&p["filename"]))).collect();
    json!({ "format": 1, "householdId": household, "tables": tables, "photos": photos })
}

async fn export(State(hub): State<Arc<Hub>>, headers: HeaderMap) -> Response {
    let Some((code, household)) = code_from(&headers) else { return error(403, "Invalid or expired transfer code.") };
    let archive = export_household(&hub, &household).to_string();
    octets(seal(&code, archive.as_bytes()))
}

fn household_photo(hub: &Hub, household: &str, filename: &str) -> Option<Vec<u8>> {
    db::one(&hub.store.db(), "SELECT 1 FROM photos WHERE household_id = ? AND filename = ?", p![household, filename])?;
    std::fs::read(hub.store.dir.join("photos").join(filename.rsplit('/').next().unwrap_or(filename))).ok()
}

async fn photo(State(hub): State<Arc<Hub>>, headers: HeaderMap, Path(filename): Path<String>) -> Response {
    let Some((code, household)) = code_from(&headers) else { return error(403, "Invalid or expired transfer code.") };
    match household_photo(&hub, &household, &filename) {
        Some(data) => octets(seal(&code, &data)),
        None => error(404, "Photo not found."),
    }
}

async fn finish(headers: HeaderMap) -> Response {
    if code_from(&headers).is_none() {
        return error(403, "Invalid or expired transfer code.");
    }
    *pending().lock().unwrap() = None;
    no_content()
}

// ---- The new hub's side ------------------------------------------------------------------

/// What a person types ("192.168.1.20", "kitchen.local:4000", "http://10.0.0.5:4000") → API base URL.
fn normalize_hub_address(input: &str) -> Option<String> {
    let raw = input.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    let with_scheme = if lower.starts_with("http://") || lower.starts_with("https://") { raw.to_string() } else { format!("http://{raw}") };
    let url = url::Url::parse(&with_scheme).ok()?;
    let host = url.host_str().filter(|h| !h.is_empty())?;
    Some(format!("{}://{}:{}/api/v1", url.scheme(), host, url.port().unwrap_or(4000)))
}

/// User-facing (409) vs. anything else (500).
enum TransferError {
    User(String),
    Failed(String),
}
fn user_err(m: &str) -> TransferError {
    TransferError::User(m.into())
}
fn failed(e: rusqlite::Error) -> TransferError {
    TransferError::Failed(e.to_string())
}

/// Claimed hubs on this network other than this one, as API base URLs.
async fn find_other_hubs(hub: &Hub) -> Vec<String> {
    let me = hub.store.identity().id.clone();
    tokio::task::spawn_blocking(move || {
        let Ok(daemon) = mdns_sd::ServiceDaemon::new() else { return Vec::new() };
        let Ok(rx) = daemon.browse("_solora._tcp.local.") else { return Vec::new() };
        let deadline = Instant::now() + Duration::from_secs(4);
        let mut found: Vec<String> = Vec::new();
        while let Some(left) = deadline.checked_duration_since(Instant::now()) {
            let Ok(event) = rx.recv_timeout(left) else { break };
            if let mdns_sd::ServiceEvent::ServiceResolved(info) = event {
                let txt = |k: &str| info.get_property_val_str(k).map(str::to_string);
                if txt("hub_id").as_deref() == Some(me.as_str()) || txt("claimed").as_deref() != Some("1") {
                    continue;
                }
                if let Some(ip) = info.get_addresses_v4().into_iter().next() {
                    let url = format!("http://{ip}:{}/api/v1", info.get_port());
                    if !found.contains(&url) {
                        found.push(url);
                    }
                }
            }
        }
        let _ = daemon.shutdown();
        found
    })
    .await
    .unwrap_or_default()
}

async fn fetch_sealed(hub: &Hub, base: &str, path: &str, code: &str) -> Option<Vec<u8>> {
    let res = hub.http.get(format!("{base}{path}")).header("X-Transfer-Code", code).timeout(Duration::from_secs(60)).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    open(code, &res.bytes().await.ok()?)
}

/// Inserts rows using only the columns this hub's schema has (the old hub may be older).
fn insert_rows(tx: &rusqlite::Connection, table: &str, rows: &[Value]) -> rusqlite::Result<()> {
    if rows.is_empty() {
        return Ok(());
    }
    let columns: Vec<String> = db::all(tx, &format!("PRAGMA table_info({table})"), p![]).iter().map(|c| db::s(c, "name")).collect();
    if columns.is_empty() {
        return Ok(());
    }
    for row in rows {
        let Some(obj) = row.as_object() else { continue };
        let keys: Vec<&String> = obj.keys().filter(|k| columns.contains(k)).collect();
        let sql = format!("INSERT OR REPLACE INTO {table} ({}) VALUES ({})", keys.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(", "), keys.iter().map(|_| "?").collect::<Vec<_>>().join(", "));
        db::run(tx, &sql, keys.iter().map(|k| db::Bind::bind(&obj[k.as_str()])).collect())?;
    }
    Ok(())
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

async fn pull_household(hub: &Hub, code: &str, from: Option<String>) -> Result<Value, TransferError> {
    if hub.store.households() > 0 {
        return Err(user_err("This hub is already set up, so it can't take over another household."));
    }
    let code = normalize(code);
    let candidates = match from {
        Some(f) => vec![f],
        None => find_other_hubs(hub).await,
    };
    if candidates.is_empty() {
        return Err(user_err("Couldn't find your old hub. Make sure it's plugged in and on the same Wi-Fi, or enter its address."));
    }
    let mut found: Option<(String, Value)> = None;
    for base in &candidates {
        if let Some(plain) = fetch_sealed(hub, base, "/transfer/export", &code).await {
            if let Ok(archive) = serde_json::from_slice::<Value>(&plain) {
                found = Some((base.clone(), archive));
                break;
            }
        }
    }
    let Some((source, archive)) = found else {
        return Err(user_err("Your old hub didn't accept that code. Check it, or start the move again on your phone."));
    };
    let mut photo_files: Vec<(String, Vec<u8>)> = Vec::new();
    for f in archive["photos"].as_array().into_iter().flatten() {
        let name = db::js_string(f);
        let data = fetch_sealed(hub, &source, &format!("/transfer/photo/{}", encode(&name)), &code).await;
        let Some(data) = data else { return Err(user_err("A photo didn't come across. Nothing was changed; try again.")) };
        photo_files.push((name.rsplit('/').next().unwrap_or(&name).to_string(), data));
    }
    let mut tables = archive["tables"].as_object().cloned().unwrap_or_default();
    if let Some(Value::Array(rows)) = tables.get_mut("calendar_providers") {
        for r in rows.iter_mut() {
            let access = encrypt_token(hub, &db::js_string(&r["access_token"]));
            r["access_token"] = json!(access);
            let refresh = r["refresh_token"].as_str().filter(|s| !s.is_empty()).map(|t| encrypt_token(hub, t));
            r["refresh_token"] = json!(refresh);
        }
    }
    let household_id = archive["householdId"].clone();
    {
        let mut db_ = hub.store.db();
        let tx = db_.transaction().map_err(failed)?;
        let empty = Vec::new();
        for table in TABLES {
            insert_rows(&tx, table, tables.get(table).and_then(Value::as_array).unwrap_or(&empty)).map_err(failed)?;
        }
        db::run(&tx, "UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE household_id IS NULL", p![household_id]).map_err(failed)?;
        tx.commit().map_err(failed)?;
    }
    let dir = hub.store.dir.join("photos");
    let _ = std::fs::create_dir_all(&dir);
    for (name, data) in &photo_files {
        let _ = std::fs::write(dir.join(name), data);
    }
    let _ = hub.http.post(format!("{source}/transfer/finish")).header("X-Transfer-Code", &code).timeout(Duration::from_secs(8)).send().await;
    let count = |t: &str| tables.get(t).and_then(Value::as_array).map_or(0, Vec::len);
    let name = tables.get("households").and_then(|h| h.get(0)).and_then(|h| h.get("name")).filter(|n| !n.is_null()).map(db::js_string).unwrap_or("Your family".into());
    Ok(json!({
        "householdName": name, "members": count("members"), "events": count("events"), "chores": count("chores"),
        "lists": count("lists"), "meals": count("meals"), "photos": photo_files.len(), "calendarsLinked": count("calendar_providers"),
    }))
}

/// Only this hub's own screen may start a pull, and only before setup.
async fn pull(State(hub): State<Arc<Hub>>, peer: Peer, body: Body) -> Response {
    if !peer.from_this_hub() {
        return error(403, "Moving a household is only started on the new hub's own screen.");
    }
    let Some(code) = body.text("code") else { return error(400, "Enter the transfer code from your phone.") };
    let from_url = match body.text("from") {
        Some(f) => match normalize_hub_address(&f) {
            Some(u) => Some(u),
            None => return error(400, "That doesn't look like a hub address, e.g. 192.168.1.20."),
        },
        None => None,
    };
    match pull_household(&hub, &code, from_url).await {
        Ok(summary) => ok(summary),
        Err(TransferError::User(m)) => error(409, m),
        Err(TransferError::Failed(m)) => {
            eprintln!("[transfer] pull failed: {m}");
            error(500, "The move didn't finish. Nothing was changed; try again.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_addresses() {
        assert_eq!(normalize("ab3d efgh"), "AB3D-EFGH");
        assert_eq!(normalize_hub_address("192.168.1.20").as_deref(), Some("http://192.168.1.20:4000/api/v1"));
        assert_eq!(normalize_hub_address("http://10.0.0.5:4100").as_deref(), Some("http://10.0.0.5:4100/api/v1"));
        assert_eq!(normalize_hub_address("http://"), None);
    }

    /// A sealed blob made by Node: crypto.scryptSync("AB3D-EFGH", "solora-hub-transfer", 32) + AES-256-GCM.
    #[test]
    fn seal_round_trip() {
        let sealed = seal("AB3D-EFGH", b"family");
        assert_eq!(open("AB3D-EFGH", &sealed).as_deref(), Some(&b"family"[..]));
        assert_eq!(open("ZZZZ-ZZZZ", &sealed), None);
    }
}
