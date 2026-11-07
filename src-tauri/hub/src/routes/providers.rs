//! Google and Microsoft calendars (routes/calendar-providers.ts,
//! services/calendar-sync.ts, lib/token-crypto.ts).
//!
//! The app signs in with the provider and hands the hub the code (or tokens);
//! the hub keeps the tokens encrypted with a key from its secret, refreshes
//! them, and every hour pulls a 90-day window of events into `events`
//! (source "google" / "microsoft"), keyed so repeated syncs are idempotent.

use crate::auth::User;
use crate::db::{self, Row};
use crate::household::{write_log, LogEntry};
use crate::http::{error, no_content, ok, Body};
use crate::{p, realtime, store, try_run, Hub};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use base64::Engine;
use chrono::{Datelike, Local, Timelike};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;

fn env(names: &[&str], default: &str) -> String {
    names.iter().find_map(|n| std::env::var(n).ok().filter(|v| !v.is_empty())).unwrap_or_else(|| default.to_string())
}
// Runtime env first, then the client baked in at build time (build.rs), since
// the in-app hub has no .env.
fn google_id() -> String { env(&["GOOGLE_CLIENT_ID", "VITE_GOOGLE_CLIENT_ID"], env!("SOLORA_BUILD_GOOGLE_CLIENT_ID")) }
fn google_secret() -> String { env(&["GOOGLE_CLIENT_SECRET", "VITE_GOOGLE_CLIENT_SECRET"], env!("SOLORA_BUILD_GOOGLE_CLIENT_SECRET")) }
fn microsoft_id() -> String { env(&["MICROSOFT_CLIENT_ID", "VITE_MICROSOFT_CLIENT_ID"], env!("SOLORA_BUILD_MICROSOFT_CLIENT_ID")) }
fn tenant() -> String {
    let baked = env!("SOLORA_BUILD_MICROSOFT_TENANT_ID");
    env(&["MICROSOFT_TENANT_ID", "VITE_MICROSOFT_TENANT_ID"], if baked.is_empty() { "common" } else { baked })
}

// ---- Tokens at rest: AES-256-GCM, key = SHA-256(secret), base64(iv ‖ tag ‖ ciphertext) ----

fn token_key(hub: &Hub) -> [u8; 32] {
    Sha256::digest(hub.store.secret().as_bytes()).into()
}

pub fn encrypt_token(hub: &Hub, text: &str) -> String {
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let sealed = Aes256Gcm::new(&token_key(hub).into()).encrypt(Nonce::from_slice(&iv), text.as_bytes()).expect("AES-GCM can't fail");
    let (ct, tag) = sealed.split_at(sealed.len() - 16);
    B64.encode([&iv[..], tag, ct].concat())
}

/// The token, or the stored value itself for tokens saved before encryption.
pub fn decrypt_token(hub: &Hub, data: &str) -> String {
    let opened = B64.decode(data).ok().filter(|b| b.len() >= 28).and_then(|b| {
        let (iv, rest) = b.split_at(12);
        let (tag, ct) = rest.split_at(16);
        Aes256Gcm::new(&token_key(hub).into()).decrypt(Nonce::from_slice(iv), [ct, tag].concat().as_slice()).ok()
    });
    opened.and_then(|p| String::from_utf8(p).ok()).unwrap_or_else(|| data.to_string())
}

// ---- Routes ------------------------------------------------------------------------------

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(list))
        .route("/sync", post(sync_now))
        .route("/google/external-calendars", get(google_calendars))
        .route("/microsoft/external-calendars", get(microsoft_categories))
        .route("/google/calendars/{calendar_id}/events", get(google_events))
        .route("/microsoft/calendars/{category}/events", get(microsoft_category_events))
        .route("/excluded-events", get(excluded).put(set_excluded))
        .route("/mappings", get(mappings).put(set_mappings))
        .route("/{provider}/exchange", post(exchange))
        .route("/{provider}/tokens", post(tokens))
        .route("/{provider}", delete(disconnect))
}

fn to_public(r: &Row) -> Value {
    json!({ "provider": r["provider"], "email": r["email"], "connectedAt": r["connected_at"] })
}

fn provider_row(hub: &Hub, household: &str, provider: &str) -> Option<Row> {
    db::one(&hub.store.db(), "SELECT * FROM calendar_providers WHERE household_id=? AND provider=?", p![household, provider])
}

async fn list(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM calendar_providers WHERE household_id = ?", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(to_public).collect()))
}

fn spawn_sync(hub: &Arc<Hub>, household: &str) {
    let (hub, household) = (hub.clone(), household.to_string());
    tokio::spawn(async move { sync_household(&hub, &household).await });
}

/// Stores (or replaces) a provider's tokens. Returns whether it was new.
fn save_tokens(hub: &Hub, household: &str, provider: &str, access: &str, refresh: Option<&str>, expires_at: Option<Value>, email: Option<Value>) -> rusqlite::Result<bool> {
    let enc_access = encrypt_token(hub, access);
    let enc_refresh = refresh.map(|r| encrypt_token(hub, r));
    match provider_row(hub, household, provider) {
        Some(existing) => {
            db::run(&hub.store.db(), "UPDATE calendar_providers SET access_token=?, refresh_token=?, expires_at=?, email=? WHERE id=?",
                p![enc_access, enc_refresh, expires_at, email, existing["id"].clone()])?;
            Ok(false)
        }
        None => {
            db::run(&hub.store.db(), "INSERT INTO calendar_providers (id, household_id, provider, access_token, refresh_token, expires_at, email) VALUES (?, ?, ?, ?, ?, ?, ?)",
                p![store::uuid(), household, provider, enc_access, enc_refresh, expires_at, email])?;
            Ok(true)
        }
    }
}

async fn send_json(req: reqwest::RequestBuilder) -> Result<(reqwest::StatusCode, Value), String> {
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    Ok((status, res.json().await.unwrap_or(Value::Null)))
}

/// A Microsoft token request. The loopback redirect is on Azure's "Mobile and
/// desktop" platform, a public client: a secret is refused (AADSTS700025) and
/// the failed attempt spends the code, so none is sent.
async fn microsoft_token(hub: &Hub, form: Vec<(&'static str, String)>) -> Result<(reqwest::StatusCode, Value), String> {
    send_json(hub.http.post(format!("https://login.microsoftonline.com/{}/oauth2/v2.0/token", tenant())).form(&form)).await
}

async fn exchange(State(hub): State<Arc<Hub>>, user: User, Path(provider): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if provider != "google" && provider != "microsoft" {
        return error(400, "Unsupported provider.");
    }
    let (Some(code), Some(verifier), Some(redirect)) = (body.str("code").filter(|s| !s.is_empty()), body.str("code_verifier").filter(|s| !s.is_empty()), body.str("redirect_uri").filter(|s| !s.is_empty())) else {
        return error(400, "code, code_verifier, and redirect_uri are required.");
    };
    let req = if provider == "google" {
        let (id, secret) = (google_id(), google_secret());
        if id.is_empty() || secret.is_empty() {
            return error(500, "Google credentials not configured on server.");
        }
        let req = hub.http.post("https://oauth2.googleapis.com/token").form(&[
            ("code", code), ("client_id", &id), ("client_secret", &secret), ("redirect_uri", redirect), ("grant_type", "authorization_code"), ("code_verifier", verifier),
        ]);
        send_json(req).await
    } else {
        let id = microsoft_id();
        if id.is_empty() {
            return error(500, "Microsoft credentials not configured on server.");
        }
        let form = vec![
            ("code", code.to_string()), ("client_id", id), ("redirect_uri", redirect.to_string()), ("grant_type", "authorization_code".into()),
            ("code_verifier", verifier.to_string()), ("scope", "Calendars.Read offline_access openid email".into()),
        ];
        microsoft_token(&hub, form).await
    };
    let (status, json) = match req {
        Ok(r) => r,
        Err(e) => return error(500, e),
    };
    if !status.is_success() {
        return error(400, json.get("error_description").and_then(Value::as_str).unwrap_or("Token exchange failed."));
    }
    let Some(access) = json.get("access_token").and_then(Value::as_str) else { return error(500, "Internal error.") };
    let email = json
        .get("id_token")
        .and_then(Value::as_str)
        .and_then(|t| t.split('.').nth(1))
        .and_then(|p| URL_SAFE_NO_PAD.decode(p.trim_end_matches('=')).ok().or_else(|| B64.decode(p).ok()))
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|c| c.get("email").cloned());
    let expires_at = json.get("expires_in").and_then(Value::as_i64).filter(|e| *e != 0).map(|e| json!(chrono::Utc::now().timestamp() + e - 60));
    let is_new = match save_tokens(&hub, &household, &provider, access, json.get("refresh_token").and_then(Value::as_str), expires_at, email) {
        Ok(n) => n,
        Err(e) => return error(500, e.to_string()),
    };
    spawn_sync(&hub, &household);
    let row = provider_row(&hub, &household, &provider).unwrap_or_default();
    if is_new {
        let name = format!("{provider} ({})", db::text(&row, "email").unwrap_or_default());
        write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&user.sub), actor_name: None, action: "provider.connect", resource_type: "calendar_provider", resource_id: None, resource_name: &name, metadata: json!({}) });
    }
    (if is_new { StatusCode::CREATED } else { StatusCode::OK }, axum::Json(to_public(&row))).into_response()
}

async fn tokens(State(hub): State<Arc<Hub>>, user: User, Path(provider): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    if provider != "google" && provider != "microsoft" {
        return error(400, "Unsupported provider.");
    }
    let Some(access) = body.str("access_token").filter(|s| !s.is_empty()) else { return error(400, "access_token is required.") };
    let is_new = match save_tokens(&hub, &household, &provider, access, body.str("refresh_token").filter(|s| !s.is_empty()), body.get("expires_at").cloned(), body.get("email").cloned()) {
        Ok(n) => n,
        Err(_) => return error(500, "Something went wrong."),
    };
    spawn_sync(&hub, &household);
    let row = provider_row(&hub, &household, &provider).unwrap_or_default();
    (if is_new { StatusCode::CREATED } else { StatusCode::OK }, axum::Json(to_public(&row))).into_response()
}

async fn disconnect(State(hub): State<Arc<Hub>>, user: User, Path(provider): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    try_run!(&hub.store.db(), "DELETE FROM events WHERE household_id=? AND source=?", p![household, provider]);
    try_run!(&hub.store.db(), "DELETE FROM calendar_providers WHERE household_id=? AND provider=?", p![household, provider]);
    write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&user.sub), actor_name: None, action: "provider.disconnect", resource_type: "calendar_provider", resource_id: None, resource_name: &provider, metadata: json!({}) });
    no_content()
}

async fn sync_now(State(hub): State<Arc<Hub>>, user: User) -> Response {
    spawn_sync(&hub, user.household().unwrap_or(""));
    ok(json!({ "ok": true }))
}

/// A usable access token for the browse routes, refreshing it if needed; None when there isn't one.
async fn valid_token_or_none(hub: &Hub, household: &str, provider: &str) -> Option<String> {
    let row = provider_row(hub, household, provider)?;
    let now = chrono::Utc::now().timestamp() as f64;
    let expires = db::number(&row, "expires_at");
    if row.get("expires_at").is_some_and(|v| !v.is_null()) && expires > now {
        return Some(decrypt_token(hub, &db::s(&row, "access_token")));
    }
    db::text(&row, "refresh_token")?;
    refresh(hub, &row).await.ok()
}

fn browse_household(user: &User) -> Result<String, Response> {
    user.household().map(str::to_string).ok_or_else(|| error(403, "No household."))
}

async fn google_calendars(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let household = match browse_household(&user) { Ok(h) => h, Err(r) => return r };
    let Some(token) = valid_token_or_none(&hub, &household, "google").await else { return error(404, "Google not connected.") };
    let res = hub.http.get("https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100").bearer_auth(token).send().await;
    let Some(json) = success_json(res).await else { return error(502, "Google calendar list fetch failed.") };
    ok(Value::Array(json["items"].as_array().into_iter().flatten().map(|c| db::defined(json!({ "id": c["id"], "name": c["summary"], "color": c.get("backgroundColor") }), &["id", "name"])).collect()))
}

async fn microsoft_categories(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let household = match browse_household(&user) { Ok(h) => h, Err(r) => return r };
    let Some(token) = valid_token_or_none(&hub, &household, "microsoft").await else { return error(404, "Microsoft not connected.") };
    let res = hub.http.get("https://graph.microsoft.com/v1.0/me/outlook/masterCategories").bearer_auth(token).send().await;
    let Some(json) = success_json(res).await else { return error(502, "Microsoft categories fetch failed.") };
    ok(Value::Array(json["value"].as_array().into_iter().flatten().map(|c| db::defined(json!({ "id": c["displayName"], "name": c["displayName"], "color": c.get("color") }), &["id", "name"])).collect()))
}

async fn success_json(res: reqwest::Result<reqwest::Response>) -> Option<Value> {
    let r = res.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.json().await.ok()
}

async fn google_events(State(hub): State<Arc<Hub>>, user: User, Path(calendar_id): Path<String>) -> Response {
    let household = match browse_household(&user) { Ok(h) => h, Err(r) => return r };
    let Some(token) = valid_token_or_none(&hub, &household, "google").await else { return error(404, "Google not connected.") };
    let url = format!("https://www.googleapis.com/calendar/v3/calendars/{}/events", encode(&calendar_id));
    let time_min = store::now_iso();
    let res = hub.http.get(url).query(&[("maxResults", "30"), ("timeMin", time_min.as_str()), ("orderBy", "startTime"), ("singleEvents", "true")]).bearer_auth(token).send().await;
    let Some(json) = success_json(res).await else { return error(502, "Google events fetch failed.") };
    ok(Value::Array(json["items"].as_array().into_iter().flatten().map(|e| {
        let start = e["start"].get("dateTime").or(e["start"].get("date")).cloned().unwrap_or(json!(""));
        let end = e["end"].get("dateTime").or(e["end"].get("date")).cloned().unwrap_or(json!(""));
        json!({ "id": e["id"], "title": e.get("summary").cloned().unwrap_or(json!("(No title)")), "start": start, "end": end, "allDay": e["start"].get("dateTime").is_none() })
    }).collect()))
}

async fn microsoft_category_events(State(hub): State<Arc<Hub>>, user: User, Path(category): Path<String>) -> Response {
    let household = match browse_household(&user) { Ok(h) => h, Err(r) => return r };
    let Some(token) = valid_token_or_none(&hub, &household, "microsoft").await else { return error(404, "Microsoft not connected.") };
    let category = category.replace('\'', "''");
    let filter = format!("categories/any(a:a eq '{category}') and end/dateTime ge '{}'", store::now_iso());
    let res = hub.http.get("https://graph.microsoft.com/v1.0/me/events")
        .query(&[("$filter", filter.as_str()), ("$top", "30"), ("$orderby", "start/dateTime"), ("$select", "id,subject,start,end,isAllDay")])
        .bearer_auth(token).send().await;
    let Some(json) = success_json(res).await else { return error(502, "Microsoft events fetch failed.") };
    ok(Value::Array(json["value"].as_array().into_iter().flatten().map(|e| json!({
        "id": e["id"], "title": e.get("subject").cloned().unwrap_or(json!("(No title)")), "start": e["start"]["dateTime"], "end": e["end"]["dateTime"],
        "allDay": e.get("isAllDay").and_then(Value::as_bool).unwrap_or(false),
    })).collect()))
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| match b {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => (b as char).to_string(),
        _ => format!("%{b:02X}"),
    }).collect()
}

async fn excluded(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(household) = user.household() else { return ok(json!([])) };
    let rows = db::all(&hub.store.db(), "SELECT provider, external_event_id FROM calendar_excluded_events WHERE household_id = ?", p![household]);
    ok(Value::Array(rows.iter().map(|r| json!({ "provider": r["provider"], "eventId": r["external_event_id"] })).collect()))
}

async fn set_excluded(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household().map(str::to_string) else { return error(403, "No household.") };
    let Some(items) = body.0.as_array().cloned() else { return error(400, "Body must be an array.") };
    let mut providers: Vec<Value> = Vec::new();
    for i in &items {
        let p_ = i.get("provider").cloned().unwrap_or(Value::Null);
        if !providers.contains(&p_) {
            providers.push(p_);
        }
    }
    {
        let mut db_ = hub.store.db();
        if let Ok(tx) = db_.transaction() {
            for prov in &providers {
                try_run!(&tx, "DELETE FROM calendar_excluded_events WHERE household_id=? AND provider=?", p![household, prov]);
            }
            for i in &items {
                if !db::truthy(i.get("provider")) || !db::truthy(i.get("eventId")) {
                    continue;
                }
                try_run!(&tx, "INSERT OR IGNORE INTO calendar_excluded_events (id, household_id, provider, external_event_id) VALUES (?, ?, ?, ?)",
                    p![store::uuid(), household, i["provider"].clone(), i["eventId"].clone()]);
            }
            let _ = tx.commit();
        };
    }
    ok(json!({ "ok": true }))
}

async fn mappings(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let Some(household) = user.household() else { return ok(json!([])) };
    let rows = db::all(&hub.store.db(), "SELECT * FROM calendar_provider_mappings WHERE household_id = ?", p![household]);
    ok(Value::Array(rows.iter().map(|r| json!({ "id": r["id"], "provider": r["provider"], "externalId": r["external_id"], "externalName": r["external_name"], "calendarId": r["calendar_id"] })).collect()))
}

async fn set_mappings(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(household) = user.household().map(str::to_string) else { return error(403, "No household.") };
    let Some(items) = body.0.as_array().cloned() else { return error(400, "Body must be an array.") };
    {
        let mut db_ = hub.store.db();
        if let Ok(tx) = db_.transaction() {
            for i in &items {
                if !db::truthy(i.get("provider")) || !db::truthy(i.get("externalId")) {
                    continue;
                }
                let name = i.get("externalName").filter(|v| !v.is_null()).cloned().unwrap_or(i["externalId"].clone());
                try_run!(&tx, "INSERT INTO calendar_provider_mappings (id, household_id, provider, external_id, external_name, calendar_id)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON CONFLICT(household_id, provider, external_id) DO UPDATE SET external_name = excluded.external_name, calendar_id = excluded.calendar_id",
                    p![store::uuid(), household, i["provider"].clone(), i["externalId"].clone(), name, i.get("calendarId").cloned()]);
            }
            let _ = tx.commit();
        };
    }
    ok(json!({ "ok": true }))
}

// ---- Sync ----------------------------------------------------------------------------------

/// A fresh access token from the refresh token (stores it).
async fn refresh(hub: &Hub, row: &Row) -> Result<String, String> {
    let provider = db::s(row, "provider");
    let refresh = db::text(row, "refresh_token").ok_or_else(|| format!("No {} refresh token stored.", if provider == "google" { "Google" } else { "Microsoft" }))?;
    let refresh = decrypt_token(hub, &refresh);
    let (status, json) = if provider == "google" {
        send_json(hub.http.post("https://oauth2.googleapis.com/token").form(&[
            ("client_id", google_id()), ("client_secret", google_secret()), ("refresh_token", refresh), ("grant_type", "refresh_token".into()),
        ]))
        .await?
    } else {
        microsoft_token(hub, vec![
            ("client_id", microsoft_id()), ("refresh_token", refresh), ("grant_type", "refresh_token".into()),
            ("scope", "Calendars.Read offline_access".into()),
        ])
        .await?
    };
    if !status.is_success() {
        return Err(format!("token refresh failed: {}", status.as_u16()));
    }
    let access = json["access_token"].as_str().ok_or("no access_token")?.to_string();
    let expires_at = chrono::Utc::now().timestamp() + json["expires_in"].as_i64().unwrap_or(0) - 60;
    let new_refresh = json.get("refresh_token").and_then(Value::as_str).map(|r| encrypt_token(hub, r));
    let _ = db::run(&hub.store.db(), "UPDATE calendar_providers SET access_token=?, refresh_token=COALESCE(?,refresh_token), expires_at=? WHERE id=?",
        p![encrypt_token(hub, &access), new_refresh, expires_at, row["id"].clone()]);
    Ok(access)
}

/// The sync's token: the stored one while valid, else a refresh (which fails without a refresh token).
async fn valid_token(hub: &Hub, row: &Row) -> Result<String, String> {
    let now = chrono::Utc::now().timestamp() as f64;
    if row.get("expires_at").is_some_and(|v| !v.is_null()) && db::number(row, "expires_at") > now {
        return Ok(decrypt_token(hub, &db::s(row, "access_token")));
    }
    refresh(hub, row).await
}

struct Normalised {
    source_event_id: String,
    title: String,
    date: String,
    end_date: Option<String>,
    all_day: bool,
    time: Option<String>,
    start_hour: f64,
    end_hour: f64,
    location: Option<String>,
    calendar_id: Option<String>,
}

/// "2024-06-01T10:00:00+00:00" → the hub's local date, "HH:MM" and hour; "2024-06-01" → that day.
fn iso_to_date(iso: &str) -> (String, Option<String>, f64) {
    if iso.contains('T') {
        if let Ok(t) = chrono::DateTime::parse_from_rfc3339(iso).map(|t| t.with_timezone(&Local)) {
            return (format!("{:04}-{:02}-{:02}", t.year(), t.month(), t.day()), Some(format!("{:02}:{:02}", t.hour(), t.minute())), t.hour() as f64 + t.minute() as f64 / 60.0);
        }
        if let Ok(n) = chrono::NaiveDateTime::parse_from_str(iso, "%Y-%m-%dT%H:%M:%S%.f") {
            return (n.format("%Y-%m-%d").to_string(), Some(n.format("%H:%M").to_string()), n.hour() as f64 + n.minute() as f64 / 60.0);
        }
    }
    (iso.to_string(), None, 0.0)
}

/// Solora's span for a provider event: exclusive end dates for all-day
/// events, and a timed event ending at midnight ends at 24 the day before.
fn event_span(start_iso: &str, end_iso: &str, all_day: bool) -> (String, Option<String>, bool, Option<String>, f64, f64) {
    let (sd, st, sh) = iso_to_date(start_iso);
    let (ed, _, eh) = iso_to_date(end_iso);
    if all_day {
        let last = crate::hometime::add_days_iso(&ed, -1);
        return (sd.clone(), (last > sd).then_some(last), true, None, 0.0, 24.0);
    }
    let (mut end_date, mut end_hour) = (ed, eh);
    if end_hour == 0.0 && end_date > sd {
        end_date = crate::hometime::add_days_iso(&end_date, -1);
        end_hour = 24.0;
    }
    (sd.clone(), (end_date > sd).then_some(end_date), false, st, sh, end_hour)
}

fn window() -> (String, String) {
    let now = chrono::Utc::now();
    let f = |d: i64| (now + chrono::Duration::days(d)).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    (f(-7), f(83))
}

async fn google_for_calendar(hub: &Hub, token: &str, google_id: &str, solora_id: Option<String>) -> Result<Vec<Normalised>, String> {
    let (min, max) = window();
    let res = hub.http.get(format!("https://www.googleapis.com/calendar/v3/calendars/{}/events", encode(google_id)))
        .query(&[("timeMin", min.as_str()), ("timeMax", max.as_str()), ("singleEvents", "true"), ("orderBy", "startTime"), ("maxResults", "500")])
        .bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Google Calendar fetch failed for {google_id}: {}", res.status().as_u16()));
    }
    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    Ok(json["items"].as_array().into_iter().flatten().filter(|e| e.get("status").and_then(Value::as_str) != Some("cancelled")).map(|e| {
        let start = e["start"].get("dateTime").or(e["start"].get("date")).and_then(Value::as_str).unwrap_or("");
        let end = e["end"].get("dateTime").or(e["end"].get("date")).and_then(Value::as_str).unwrap_or("");
        let (date, end_date, all_day, time, start_hour, end_hour) = event_span(start, end, e["start"].get("dateTime").is_none());
        Normalised {
            source_event_id: e["id"].as_str().unwrap_or("").to_string(), title: e.get("summary").and_then(Value::as_str).unwrap_or("(No title)").to_string(),
            date, end_date, all_day, time, start_hour, end_hour, location: e.get("location").and_then(Value::as_str).map(str::to_string), calendar_id: solora_id.clone(),
        }
    }).collect())
}

async fn google_events_for(hub: &Hub, token: &str, household: &str) -> Result<Vec<Normalised>, String> {
    let maps = db::all(&hub.store.db(), "SELECT external_id, calendar_id FROM calendar_provider_mappings WHERE household_id=? AND provider='google'", p![household]);
    // No mappings: the primary calendar, unassigned.
    if maps.is_empty() {
        return google_for_calendar(hub, token, "primary", None).await;
    }
    let mut out = Vec::new();
    for m in maps {
        match google_for_calendar(hub, token, &db::s(&m, "external_id"), db::text(&m, "calendar_id")).await {
            Ok(mut e) => out.append(&mut e),
            Err(e) => eprintln!("[calendar-sync] Google fetch failed for mapped calendar {}: {e}", db::s(&m, "external_id")),
        }
    }
    Ok(out)
}

async fn microsoft_events_for(hub: &Hub, token: &str, household: &str) -> Result<Vec<Normalised>, String> {
    let (min, max) = window();
    let res = hub.http.get("https://graph.microsoft.com/v1.0/me/calendarView")
        .query(&[("startDateTime", min.as_str()), ("endDateTime", max.as_str()), ("$select", "id,subject,start,end,isAllDay,location,isCancelled,categories"), ("$top", "500"), ("$orderby", "start/dateTime")])
        .bearer_auth(token).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Microsoft Graph fetch failed: {}", res.status().as_u16()));
    }
    let json: Value = res.json().await.map_err(|e| e.to_string())?;
    let maps = db::all(&hub.store.db(), "SELECT external_id, calendar_id FROM calendar_provider_mappings WHERE household_id=? AND provider='microsoft'", p![household]);
    // Graph returns UTC times without a zone suffix unless asked otherwise.
    let utc = |t: &Value| {
        let dt = t["dateTime"].as_str().unwrap_or("").to_string();
        let has_zone = dt.ends_with('Z') || dt.ends_with('z') || dt.len() > 6 && (dt.as_bytes()[dt.len() - 6] == b'+' || dt.as_bytes()[dt.len() - 6] == b'-') && dt.as_bytes()[dt.len() - 3] == b':';
        if t["timeZone"].as_str() == Some("UTC") && !has_zone { format!("{dt}Z") } else { dt }
    };
    Ok(json["value"].as_array().into_iter().flatten().filter(|e| !e.get("isCancelled").and_then(Value::as_bool).unwrap_or(false)).map(|e| {
        let all_day = e.get("isAllDay").and_then(Value::as_bool).unwrap_or(false);
        let (date, end_date, all_day, time, start_hour, end_hour) = if all_day {
            let cut = |t: &Value| t["dateTime"].as_str().unwrap_or("").chars().take(10).collect::<String>();
            event_span(&cut(&e["start"]), &cut(&e["end"]), true)
        } else {
            event_span(&utc(&e["start"]), &utc(&e["end"]), false)
        };
        // The first mapped category, else none (General).
        let calendar_id = e.get("categories").and_then(Value::as_array).into_iter().flatten()
            .find_map(|c| maps.iter().find(|m| m.get("external_id") == Some(c)).map(|m| db::text(m, "calendar_id")))
            .flatten();
        Normalised {
            source_event_id: e["id"].as_str().unwrap_or("").to_string(), title: e.get("subject").and_then(Value::as_str).unwrap_or("(No title)").to_string(),
            date, end_date, all_day, time, start_hour, end_hour,
            location: e.get("location").and_then(|l| l.get("displayName")).and_then(Value::as_str).map(str::to_string), calendar_id,
        }
    }).collect())
}

fn upsert_events(hub: &Hub, household: &str, source: &str, events: &[Normalised]) -> usize {
    let excluded: Vec<String> = db::all(&hub.store.db(), "SELECT external_event_id FROM calendar_excluded_events WHERE household_id=? AND provider=?", p![household, source])
        .iter().map(|r| db::s(r, "external_event_id")).collect();
    let valid: Vec<&Normalised> = events.iter().filter(|e| !e.source_event_id.trim().is_empty() && !excluded.contains(&e.source_event_id)).collect();
    let mut db_ = hub.store.db();
    let Ok(tx) = db_.transaction() else { return 0 };
    for e in &valid {
        let _ = db::run(&tx, "
            INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, location, source, source_event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(household_id, source, source_event_id) DO UPDATE SET
              title = excluded.title, date = excluded.date, end_date = excluded.end_date, all_day = excluded.all_day, time = excluded.time,
              start_hour = excluded.start_hour, end_hour = excluded.end_hour, location = excluded.location, calendar_id = excluded.calendar_id",
            p![store::uuid(), household, e.calendar_id.clone(), e.title.clone(), e.date.clone(), e.end_date.clone(), e.all_day, e.time.clone(), e.start_hour, e.end_hour, e.location.clone(), source, e.source_event_id.clone()]);
    }
    let _ = tx.commit();
    valid.len()
}

pub async fn sync_household(hub: &Arc<Hub>, household: &str) {
    let rows = db::all(&hub.store.db(), "SELECT * FROM calendar_providers WHERE household_id = ?", p![household]);
    for row in rows {
        let provider = db::s(&row, "provider");
        let result = async {
            let token = valid_token(hub, &row).await?;
            if provider == "google" { google_events_for(hub, &token, household).await } else { microsoft_events_for(hub, &token, household).await }
        }.await;
        match result {
            Ok(events) => {
                let count = upsert_events(hub, household, &provider, &events);
                println!("[calendar-sync] {provider} → {household}: {count} events upserted");
                if count > 0 {
                    realtime::broadcast(hub, household, "events:updated", json!({}));
                }
            }
            Err(e) => eprintln!("[calendar-sync] {provider} sync failed for {household}: {e}"),
        }
    }
}

/// Every connected household now, then hourly.
pub fn start_scheduler(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let households: Vec<String> = db::all(&hub.store.db(), "SELECT DISTINCT household_id FROM calendar_providers", p![]).iter().map(|r| db::s(r, "household_id")).collect();
            for h in households {
                sync_household(&hub, &h).await;
            }
        }
    });
    println!("[calendar-sync] Scheduler started — syncing every hour.");
}

#[cfg(test)]
mod tests {
    #[test]
    fn spans() {
        let (d, e, all, _, s, f) = super::event_span("2031-05-10", "2031-05-12", true);
        assert_eq!((d.as_str(), e.as_deref(), all, s, f), ("2031-05-10", Some("2031-05-11"), true, 0.0, 24.0));
        let (_, e, _, _, _, _) = super::event_span("2031-05-10", "2031-05-11", true);
        assert_eq!(e, None, "a one-day event ends the next day, exclusively");
    }
}
