//! /api/v1/photos and the /photo-files static route (routes/photos.ts, index.ts).
//! Photos are files in <data>/photos/<uuid>.<ext>; the database keeps the name.

use crate::auth::{authenticate, User};
use crate::db::{self, Row};
use crate::household::log_activity;
use crate::http::{created, error, no_content, ok, Body};
use crate::{p, realtime, store, try_run, Hub};
use axum::extract::{FromRequest, Multipart, Path, Query, Request, State};
use axum::http::{header, HeaderValue};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

const UPLOAD_LIMIT: usize = 20 * 1024 * 1024;
const CHUNK_BYTES: usize = 512 * 1024;
const ALLOWED: [&str; 5] = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic"];
const MIME: [(&str, &str); 6] = [(".jpg", "image/jpeg"), (".jpeg", "image/jpeg"), (".png", "image/png"), (".webp", "image/webp"), (".gif", "image/gif"), (".heic", "image/heic")];

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(list).post(upload))
        .route("/base64", axum::routing::post(upload_base64))
        .route("/{id}/file", get(file))
        .route("/{id}/chunk", get(chunk))
        .route("/{id}", axum::routing::delete(remove))
        // Multipart up to 20 MB; base64 JSON up to 5 MB (a 3 MB photo plus a third).
        .layer(axum::extract::DefaultBodyLimit::max(UPLOAD_LIMIT + 1024 * 1024))
}

fn photos_dir(hub: &Hub) -> std::path::PathBuf {
    hub.store.dir.join("photos")
}

fn ext_of(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if i > 0 => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

fn mime_of(file: &str) -> &'static str {
    let ext = ext_of(file);
    MIME.iter().find(|(e, _)| *e == ext).map(|(_, m)| *m).unwrap_or("application/octet-stream")
}

pub fn row_to_photo(r: &Row) -> Value {
    json!({ "id": r["id"], "householdId": r["household_id"], "filename": r["filename"], "src": r["src"], "caption": r["caption"], "createdAt": r["created_at"] })
}

async fn list(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM photos WHERE household_id = ? ORDER BY created_at DESC", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(row_to_photo).collect()))
}

fn store_photo(hub: &Arc<Hub>, user: &User, filename: &str, caption: &str) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let id = store::uuid();
    let db_ = hub.store.db();
    try_run!(&db_, "INSERT INTO photos (id, household_id, filename, src, caption) VALUES (?, ?, ?, ?, ?)", p![id, household, filename, format!("/photo-files/{filename}"), caption]);
    let photo = db::one(&db_, "SELECT * FROM photos WHERE id = ?", p![id]).map(|r| row_to_photo(&r)).unwrap_or(Value::Null);
    drop(db_);
    log_activity(hub, user, "photo.add", "photo", Some(&id), "", json!({}));
    realtime::broadcast(hub, &household, "photos:created", photo.clone());
    created(photo)
}

/// multer: field "file" (images only, 20 MB), optional "caption".
async fn upload(State(hub): State<Arc<Hub>>, user: User, req: Request) -> Response {
    let Ok(mut form) = Multipart::from_request(req, &hub).await else { return error(400, "No file uploaded.") };
    let mut saved: Option<String> = None;
    let mut caption = String::new();
    loop {
        let field = match form.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) if e.status() == axum::http::StatusCode::PAYLOAD_TOO_LARGE => return error(413, "That upload is too large."),
            Err(_) => return error(500, "Something went wrong."),
        };
        match field.name() {
            Some("file") if saved.is_none() => {
                let mime = field.content_type().unwrap_or("").to_string();
                if !ALLOWED.contains(&mime.as_str()) {
                    // multer's fileFilter error reaches Express's error handler.
                    eprintln!("[solora] Unhandled error: Only image files are allowed.");
                    return error(500, "Something went wrong.");
                }
                let ext = { let e = ext_of(field.file_name().unwrap_or("")); if e.is_empty() { ".jpg".to_string() } else { e } };
                let bytes = match field.bytes().await {
                    Ok(b) => b,
                    Err(_) => return error(413, "That upload is too large."),
                };
                let name = format!("{}{ext}", store::uuid());
                if std::fs::create_dir_all(photos_dir(&hub)).and_then(|_| std::fs::write(photos_dir(&hub).join(&name), &bytes)).is_err() {
                    return error(500, "Something went wrong.");
                }
                saved = Some(name);
            }
            Some("caption") => caption = field.text().await.unwrap_or_default(),
            _ => {}
        }
    }
    let Some(name) = saved else { return error(400, "No file uploaded.") };
    store_photo(&hub, &user, &name, caption.trim())
}

async fn upload_base64(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let mime = body.str("mime").unwrap_or("");
    let ext = MIME.iter().find(|(_, m)| *m == mime).map(|(e, _)| *e);
    let (Some(data), Some(ext)) = (body.str("data").filter(|d| !d.is_empty()), ext) else {
        return error(400, "Send a JPEG, PNG, WebP, GIF or HEIC image.");
    };
    // Buffer.from(data, "base64") ignores what isn't base64.
    let cleaned: String = data.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/').collect();
    let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(cleaned.trim_end_matches('=')).unwrap_or_default();
    if bytes.is_empty() || bytes.len() > 3 * 1024 * 1024 {
        return error(413, "That photo is too large.");
    }
    let name = format!("{}{}", store::uuid(), if ext == ".jpeg" { ".jpg" } else { ext });
    if std::fs::create_dir_all(photos_dir(&hub)).and_then(|_| std::fs::write(photos_dir(&hub).join(&name), &bytes)).is_err() {
        return error(500, "Something went wrong.");
    }
    let caption: String = body.raw("caption").map(db::js_string).unwrap_or_default().trim().chars().take(200).collect();
    store_photo(&hub, &user, &name, &caption)
}

fn photo_file(hub: &Hub, household: &str, id: &str) -> Option<std::path::PathBuf> {
    let row = db::one(&hub.store.db(), "SELECT filename FROM photos WHERE id = ? AND household_id = ?", p![id, household])?;
    let name = db::s(&row, "filename");
    let file = photos_dir(hub).join(name.rsplit('/').next().unwrap_or(&name));
    file.exists().then_some(file)
}

fn send_file(path: &std::path::Path, mime: &str) -> Response {
    match std::fs::read(path) {
        Ok(bytes) => (
            [(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap()), (header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=86400"))],
            bytes,
        )
            .into_response(),
        Err(_) => error(404, "Not found."),
    }
}

async fn file(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    match photo_file(&hub, user.household().unwrap_or(""), &id) {
        Some(f) => send_file(&f, mime_of(&f.to_string_lossy())),
        None => error(404, "Photo not found."),
    }
}

async fn chunk(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(f) = photo_file(&hub, user.household().unwrap_or(""), &id) else { return error(404, "Photo not found.") };
    let Ok(bytes) = std::fs::read(&f) else { return error(404, "Photo not found.") };
    let parts = bytes.len().div_ceil(CHUNK_BYTES).max(1);
    // Number(undefined ?? 0)
    let part = q.get("part").map(|p| p.trim().parse::<f64>().unwrap_or(f64::NAN)).unwrap_or(0.0);
    if part.fract() != 0.0 || part < 0.0 || part >= parts as f64 {
        return error(404, "No such part.");
    }
    let start = part as usize * CHUNK_BYTES;
    let slice = &bytes[start..(start + CHUNK_BYTES).min(bytes.len())];
    ok(json!({ "mime": mime_of(&f.to_string_lossy()), "part": part as usize, "parts": parts, "data": B64.encode(slice) }))
}

async fn remove(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let row = db::one(&hub.store.db(), "SELECT * FROM photos WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(row) = row else { return error(404, "Photo not found.") };
    let _ = std::fs::remove_file(photos_dir(&hub).join(db::s(&row, "filename")));
    try_run!(&hub.store.db(), "DELETE FROM photos WHERE id = ? AND household_id = ?", p![id, household]);
    log_activity(&hub, &user, "photo.delete", "photo", Some(&id), "", json!({}));
    realtime::broadcast(&hub, &household, "photos:deleted", json!(id));
    no_content()
}

/// GET /photo-files/<name>: the same token check as the API, and a ?token=
/// is accepted for <img> tags that can't set a header.
pub async fn static_file(State(hub): State<Arc<Hub>>, Path(name): Path<String>, Query(q): Query<HashMap<String, String>>, headers: axum::http::HeaderMap) -> Response {
    let header_token = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).map(str::to_string);
    let token = match header_token {
        Some(h) => match h.strip_prefix("Bearer ") {
            Some(t) => t.trim().to_string(),
            None => return crate::auth::Refused::Missing.response(),
        },
        None => match q.get("token") {
            Some(t) => t.trim().to_string(),
            None => return crate::auth::Refused::Missing.response(),
        },
    };
    if let Err(r) = authenticate(&hub, &token).await {
        return r.response();
    }
    if name.contains('/') || name.contains('\\') || name.starts_with('.') {
        return error(404, "Not found.");
    }
    let path = photos_dir(&hub).join(&name);
    if !path.is_file() {
        return error(404, "Not found.");
    }
    send_file(&path, mime_of(&name))
}
