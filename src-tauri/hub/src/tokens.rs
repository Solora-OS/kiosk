//! Tokens the hub accepts (kiosk/server/src/middleware/auth.ts and
//! lib/account-tokens.ts):
//!
//! - Device tokens (walls, kids' phones, refresh and presence passes): HS256,
//!   signed with the hub's secret. Same claims as jsonwebtoken writes, so
//!   tokens from the Node hub stay valid here and the other way round.
//! - Account tokens: ES256 from Solora central (iss lumora-central,
//!   aud lumora-users), checked against central's JWKS, cached by `kid`.

use base64::Engine;
use jsonwebtoken::{decode, decode_header, encode, errors::ErrorKind, jwk::JwkSet, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ISSUER: &str = "lumora-central";
const AUDIENCE: &str = "lumora-users";

/// jsonwebtoken's `expiresIn` strings: "30s", "24h", "30d", "87600h".
fn seconds(expires_in: &str) -> i64 {
    let (n, unit) = expires_in.split_at(expires_in.len() - 1);
    let n: i64 = n.parse().unwrap_or(0);
    n * match unit {
        "s" => 1,
        "m" => 60,
        "h" => 3600,
        "d" => 86_400,
        _ => 1,
    }
}

/// Signs `claims` (sub, role, name, householdId, typ…) plus iat and exp.
pub fn sign(secret: &str, claims: Value, expires_in: &str) -> String {
    let now = chrono::Utc::now().timestamp();
    let mut map = match claims {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    map.retain(|_, v| !v.is_null());
    map.insert("iat".into(), json!(now));
    map.insert("exp".into(), json!(now + seconds(expires_in)));
    encode(&Header::new(Algorithm::HS256), &Value::Object(map), &EncodingKey::from_secret(secret.as_bytes()))
        .expect("HS256 signing can't fail")
}

pub enum TokenError {
    Expired,
    Invalid,
}

/// Verifies an HS256 token of any kind and returns its claims.
pub fn verify_any(secret: &str, token: &str) -> Result<Map<String, Value>, TokenError> {
    let mut v = Validation::new(Algorithm::HS256);
    v.leeway = 0;
    v.validate_aud = false;
    v.required_spec_claims = HashSet::new();
    match decode::<Map<String, Value>>(token, &DecodingKey::from_secret(secret.as_bytes()), &v) {
        Ok(data) => Ok(data.claims),
        Err(e) if matches!(e.kind(), ErrorKind::ExpiredSignature) => Err(TokenError::Expired),
        Err(_) => Err(TokenError::Invalid),
    }
}

/// `verifyToken`: an access token; refresh tokens and presence passes are refused.
pub fn verify_access(secret: &str, token: &str) -> Result<Map<String, Value>, TokenError> {
    let claims = verify_any(secret, token)?;
    match claims.get("typ").and_then(Value::as_str) {
        Some("refresh") | Some("presence") => Err(TokenError::Invalid),
        _ => Ok(claims),
    }
}

/// `verifyRefreshToken`.
pub fn verify_refresh(secret: &str, token: &str) -> Option<Map<String, Value>> {
    let claims = verify_any(secret, token).ok()?;
    (claims.get("typ").and_then(Value::as_str) == Some("refresh")).then_some(claims)
}

/// Access + refresh tokens for a phone signed in without an account.
pub fn member_device_tokens(secret: &str, id: &str, household_id: &str, name: &str) -> Value {
    let payload = json!({ "sub": id, "householdId": household_id, "name": name, "role": "member" });
    let mut refresh = payload.clone();
    refresh["typ"] = json!("refresh");
    json!({ "token": sign(secret, payload, "24h"), "refreshToken": sign(secret, refresh, "365d") })
}

/// The claims of a JWT without checking its signature (jwt.decode).
pub fn peek(token: &str) -> Option<Map<String, Value>> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// True if the token claims to be a central account token (cheap, unverified).
pub fn is_account_token(token: &str) -> bool {
    peek(token).is_some_and(|c| c.get("iss").and_then(Value::as_str) == Some(ISSUER) && c.get("aud").and_then(Value::as_str) == Some(AUDIENCE))
}

pub struct Account {
    pub sub: String,
    pub email: String,
    pub name: String,
}

/// Central's signing keys, fetched once and cached by kid, so checking a
/// sign-in works while the internet is down.
pub struct AccountKeys {
    url: String,
    http: reqwest::Client,
    keys: Mutex<HashMap<String, DecodingKey>>,
    last_fetch: Mutex<Option<Instant>>,
}

impl AccountKeys {
    pub fn new(central_api_url: &str, http: reqwest::Client) -> Self {
        AccountKeys {
            url: format!("{}/.well-known/jwks.json", central_api_url.trim_end_matches('/')),
            http,
            keys: Mutex::new(HashMap::new()),
            last_fetch: Mutex::new(None),
        }
    }

    async fn fetch(&self) {
        {
            // An unknown kid mustn't let every request hammer central.
            let mut last = self.last_fetch.lock().unwrap();
            if last.is_some_and(|t| t.elapsed() < Duration::from_secs(30)) {
                return;
            }
            *last = Some(Instant::now());
        }
        let res = self.http.get(&self.url).timeout(Duration::from_secs(5)).send().await;
        let set = match res {
            Ok(r) if r.status().is_success() => r.json::<JwkSet>().await.ok(),
            Ok(r) => {
                eprintln!("[auth] Could not fetch central signing keys: JWKS fetch failed: {}", r.status().as_u16());
                None
            }
            Err(e) => {
                eprintln!("[auth] Could not fetch central signing keys: {e}");
                None
            }
        };
        let Some(set) = set else { return };
        let mut keys = self.keys.lock().unwrap();
        for jwk in &set.keys {
            if let (Some(kid), Ok(key)) = (jwk.common.key_id.clone(), DecodingKey::from_jwk(jwk)) {
                keys.insert(kid, key);
            }
        }
    }

    /// `verifyAccountToken`: the account, or None if invalid, expired or unverifiable.
    pub async fn verify(&self, token: &str) -> Option<Account> {
        let header = decode_header(token).ok()?;
        if header.alg != Algorithm::ES256 {
            return None;
        }
        let kid = header.kid?;
        if !self.keys.lock().unwrap().contains_key(&kid) {
            self.fetch().await;
        }
        let key = self.keys.lock().unwrap().get(&kid)?.clone();
        let mut v = Validation::new(Algorithm::ES256);
        v.leeway = 0;
        v.set_issuer(&[ISSUER]);
        v.set_audience(&[AUDIENCE]);
        v.required_spec_claims = HashSet::new();
        let claims = decode::<Map<String, Value>>(token, &key, &v).ok()?.claims;
        let text = |k: &str| claims.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Some(Account { sub: claims.get("sub")?.as_str()?.to_string(), email: text("email"), name: text("name") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_tokens_round_trip() {
        let t = sign("s3cret", json!({ "sub": "a", "role": "kiosk", "name": "Wall", "householdId": null }), "87600h");
        let c = verify_access("s3cret", &t).ok().unwrap();
        assert_eq!(c["sub"], "a");
        assert!(c.get("householdId").is_none(), "nulls are left out, like undefined");
        assert!(verify_access("other", &t).is_err());
    }

    #[test]
    fn refresh_tokens_only_refresh() {
        let pair = member_device_tokens("k", "u", "h", "Leo");
        let refresh = pair["refreshToken"].as_str().unwrap();
        assert!(verify_access("k", refresh).is_err());
        assert!(verify_refresh("k", refresh).is_some());
        assert!(verify_refresh("k", pair["token"].as_str().unwrap()).is_none());
    }
}
