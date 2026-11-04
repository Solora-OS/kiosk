//! HTTP plumbing that matches the Node hub's Express setup (index.ts): JSON
//! bodies that default to `{}`, its error messages, `{ error }` responses,
//! and "is this request from the hub's own screen" (lib/loopback.ts).

use axum::body::Bytes;
use axum::extract::{ConnectInfo, FromRequest, FromRequestParts, Request};
use axum::http::{header::CONTENT_TYPE, request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::net::SocketAddr;

/// `res.status(status).json({ error })`.
pub fn error(status: u16, message: impl Into<String>) -> Response {
    (StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR), Json(json!({ "error": message.into() }))).into_response()
}

pub fn ok(body: Value) -> Response {
    Json(body).into_response()
}

pub fn created(body: Value) -> Response {
    (StatusCode::CREATED, Json(body)).into_response()
}

pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

/// An object without its null fields, for values that are `undefined` in the
/// Node hub (JSON.stringify leaves those out; explicit nulls use json! as is).
pub fn defined(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).collect()),
        other => other,
    }
}

/// The 404 for anything no route answers (including a known path with another method).
pub async fn not_found() -> Response {
    error(404, "Not found.")
}

/// `req.body` after express.json(): the parsed object or array, `{}` when
/// there's no JSON body, 400 for broken JSON, 413 past the 2 MB limit.
pub struct Body(pub Value);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Response> {
        let is_json = req
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.to_ascii_lowercase().contains("json"));
        let bytes = Bytes::from_request(req, state).await.map_err(|e| {
            if e.status() == StatusCode::PAYLOAD_TOO_LARGE {
                error(413, "That upload is too large.")
            } else {
                error(400, "That request wasn't valid JSON.")
            }
        })?;
        if !is_json || bytes.is_empty() {
            return Ok(Body(json!({})));
        }
        // express.json is strict: only an object or an array.
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => Ok(Body(v)),
            _ => Err(error(400, "That request wasn't valid JSON.")),
        }
    }
}

impl Body {
    /// A string field (`req.body.x` when it's a string).
    pub fn str(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(Value::as_str)
    }
    /// A string field, trimmed, or None when missing or blank (`x?.trim()` truthy).
    pub fn text(&self, key: &str) -> Option<String> {
        self.str(key).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
    }
    /// A field that isn't null (`x ?? fallback` treats null and undefined alike).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key).filter(|v| !v.is_null())
    }
    /// A field that's present, null included (`x !== undefined`; destructuring defaults only replace undefined).
    pub fn raw(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }
    pub fn has(&self, key: &str) -> bool {
        self.0.get(key).is_some()
    }
}

/// The caller's address, and whether it's this machine (the hub's own screen).
#[derive(Clone, Copy)]
pub struct Peer(pub SocketAddr);

impl Peer {
    pub fn from_this_hub(&self) -> bool {
        match self.0.ip() {
            std::net::IpAddr::V4(ip) => ip.is_loopback() && ip.octets() == [127, 0, 0, 1],
            std::net::IpAddr::V6(ip) => ip.is_loopback() || ip.to_ipv4_mapped().is_some_and(|v4| v4.octets() == [127, 0, 0, 1]),
        }
    }
}

impl<S: Send + Sync> FromRequestParts<S> for Peer {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, state: &S) -> Result<Self, Response> {
        let ConnectInfo(addr) = ConnectInfo::<SocketAddr>::from_request_parts(parts, state)
            .await
            .map_err(|_| error(500, "Something went wrong."))?;
        Ok(Peer(addr))
    }
}

/// This hub's API base URL on the home network (services/invite-relay.ts `lanBaseUrl`).
pub fn lan_base_url(port: u16) -> Option<String> {
    let ifs = local_ip_address::list_afinet_netifas().ok()?;
    ifs.into_iter().find_map(|(_, ip)| match ip {
        std::net::IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(format!("http://{v4}:{port}/api/v1")),
        _ => None,
    })
}
