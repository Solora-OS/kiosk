//! `requireAuth` (kiosk/server/src/middleware/auth.ts): who a request is from.

use crate::http::error;
use crate::tokens::{self, TokenError};
use crate::Hub;
use axum::extract::FromRequestParts;
use axum::http::{header::AUTHORIZATION, request::Parts};
use axum::response::Response;
use serde_json::{Map, Value};
use std::sync::Arc;

/// The signed-in caller. `sub` is the local user id (or the display's id).
#[derive(Debug, Clone)]
pub struct User {
    pub sub: String,
    pub household_id: Option<String>,
    pub email: Option<String>,
    pub name: Option<String>,
    pub role: Option<String>,
}

impl User {
    pub fn is_kiosk(&self) -> bool {
        self.role.as_deref() == Some("kiosk")
    }
    /// The household, if the caller has one ("" counts as none).
    pub fn household(&self) -> Option<&str> {
        self.household_id.as_deref().filter(|h| !h.is_empty())
    }
}

/// Why a token was refused, as the client sees it.
pub enum Refused {
    Missing,
    Invalid,
    Expired,
    AccountInvalid,
    SignedOut,
}

impl Refused {
    pub fn response(&self) -> Response {
        error(401, match self {
            Refused::Missing => "Missing or malformed Authorization header.",
            Refused::Invalid => "Invalid token.",
            Refused::Expired => "Token expired.",
            Refused::AccountInvalid => "Invalid or expired token.",
            Refused::SignedOut => "This phone has been signed out of the household.",
        })
    }
}

fn text(c: &Map<String, Value>, k: &str) -> Option<String> {
    c.get(k).and_then(Value::as_str).map(str::to_string)
}

/// A hub-issued member token only works while its local user still exists.
pub fn member_still_linked(hub: &Hub, role: Option<&str>, sub: &str, household_id: Option<&str>) -> bool {
    if role != Some("member") {
        return true;
    }
    hub.store
        .db()
        .query_row("SELECT 1 FROM users WHERE id = ? AND household_id = ?", [sub, household_id.unwrap_or("")], |_| Ok(()))
        .is_ok()
}

/// A display's household, for a kiosk token minted before it was paired.
fn kiosk_household(hub: &Hub, id: &str) -> Option<String> {
    hub.store
        .db()
        .query_row("SELECT household_id FROM kiosk_devices WHERE id = ?", [id], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
}

/// Resolves a bearer token the way requireAuth does.
pub async fn authenticate(hub: &Hub, token: &str) -> Result<User, Refused> {
    if tokens::is_account_token(token) {
        let account = hub.keys.verify(token).await.ok_or(Refused::AccountInvalid)?;
        let row = hub
            .store
            .db()
            .query_row("SELECT id, household_id, name, email FROM users WHERE account_id = ?", [&account.sub], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
            })
            .ok();
        return Ok(match row {
            Some((id, household, name, email)) => User {
                sub: id,
                household_id: household,
                email: email.or(Some(account.email)),
                name: name.or(Some(account.name)),
                role: Some("member".into()),
            },
            None => User { sub: account.sub, household_id: None, email: Some(account.email), name: Some(account.name), role: Some("member".into()) },
        });
    }
    let claims = tokens::verify_access(hub.store.secret(), token).map_err(|e| match e {
        TokenError::Expired => Refused::Expired,
        TokenError::Invalid => Refused::Invalid,
    })?;
    let sub = text(&claims, "sub").unwrap_or_default();
    let role = text(&claims, "role");
    let mut household_id = text(&claims, "householdId");
    if role.as_deref() == Some("kiosk") && household_id.is_none() {
        household_id = kiosk_household(hub, &sub);
    }
    if !member_still_linked(hub, role.as_deref(), &sub, household_id.as_deref()) {
        return Err(Refused::SignedOut);
    }
    Ok(User { sub, household_id, email: text(&claims, "email"), name: text(&claims, "name"), role })
}

pub fn bearer(parts: &Parts) -> Option<String> {
    let h = parts.headers.get(AUTHORIZATION)?.to_str().ok()?;
    h.strip_prefix("Bearer ").map(|t| t.trim().to_string())
}

impl FromRequestParts<Arc<Hub>> for User {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, hub: &Arc<Hub>) -> Result<User, Response> {
        let token = bearer(parts).ok_or_else(|| Refused::Missing.response())?;
        authenticate(hub, &token).await.map_err(|r| r.response())
    }
}
