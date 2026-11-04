//! House-level settings: /api/v1/home (the widget layout), /away, /summer and
//! /seasons (routes/home.ts, away.ts, summer.ts, seasons.ts).

use crate::auth::User;
use crate::db::{self, is_iso_date, num};
use crate::hometime::home_today;
use crate::household::{log_activity, manages};
use crate::http::{error, no_content, ok, Body};
use crate::{p, try_run, realtime, Hub};
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::{json, Map, Value};
use std::sync::Arc;

pub fn home() -> Router<Arc<Hub>> {
    Router::new().route("/", get(get_home).put(put_home))
}
pub fn away() -> Router<Arc<Hub>> {
    Router::new().route("/", get(get_away).put(put_away).delete(end_away))
}
pub fn summer() -> Router<Arc<Hub>> {
    Router::new().route("/", get(get_summer).put(put_summer).delete(end_summer))
}
pub fn seasons() -> Router<Arc<Hub>> {
    Router::new().route("/", get(get_seasons).put(put_seasons))
}

/// `s.slice(0, n)` (UTF-16 units, close enough for these short fields).
fn slice(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---- Home screen ------------------------------------------------------------------------------

/// Well-formed widgets only; the apps decide which types they know.
fn clean_layout(body: &Value) -> Option<Value> {
    let widgets = body.get("widgets")?.as_array()?;
    if widgets.len() > 40 {
        return None;
    }
    let mut out = Vec::new();
    for w in widgets {
        let id = w.get("id")?.as_str()?;
        let kind = w.get("type")?.as_str()?;
        let size = w.get("size")?.as_str()?;
        let id_ok = (1..=40).contains(&id.chars().count()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        let kind_ok = (1..=24).contains(&kind.len()) && kind.bytes().all(|b| b.is_ascii_lowercase() || b == b'-');
        if !id_ok || !kind_ok || !["s", "m", "l", "full"].contains(&size) {
            return None;
        }
        let mut widget = json!({ "id": id, "type": kind, "size": size });
        if let Some(c @ (Value::Object(_) | Value::Array(_))) = w.get("config") {
            widget["config"] = c.clone();
        }
        out.push(widget);
    }
    Some(json!({ "widgets": out }))
}

async fn get_home(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let row = db::one(&hub.store.db(), "SELECT home_layout FROM households WHERE id = ?", p![user.household_id.clone()]);
    ok(row.and_then(|r| db::text(&r, "home_layout")).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(Value::Null))
}

async fn put_home(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let Some(layout) = clean_layout(&body.0) else { return error(400, "That home screen layout isn't valid.") };
    let text = layout.to_string();
    if text.encode_utf16().count() > 20_000 {
        return error(413, "That home screen has too much on it.");
    }
    try_run!(&hub.store.db(), "UPDATE households SET home_layout = ? WHERE id = ?", p![text, user.household_id.clone()]);
    ok(layout)
}

// ---- Away -------------------------------------------------------------------------------------

fn current_away(hub: &Hub, household: &str) -> Value {
    let row = db::one(&hub.store.db(), "SELECT away_from, away_until, away_label FROM households WHERE id = ?", p![household]);
    let Some(r) = row else { return Value::Null };
    match (db::text(&r, "away_from"), db::text(&r, "away_until")) {
        (Some(from), Some(until)) if !from.is_empty() && !until.is_empty() && until >= home_today(hub) => {
            db::defined(json!({ "from": from, "until": until, "label": db::opt(&r, "away_label") }), &[])
        }
        _ => Value::Null,
    }
}

fn away_parent(hub: &Hub, user: &User) -> Result<(), Response> {
    if !user.is_kiosk() && manages(hub, user, "chores") { Ok(()) } else { Err(error(403, "A parent sets away time.")) }
}

async fn get_away(State(hub): State<Arc<Hub>>, user: User) -> Response {
    ok(current_away(&hub, user.household().unwrap_or("")))
}

async fn put_away(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if let Err(r) = away_parent(&hub, &user) {
        return r;
    }
    let (from, until) = (body.raw("from"), body.raw("until"));
    if !is_iso_date(from) || !is_iso_date(until) || until.and_then(Value::as_str) < from.and_then(Value::as_str) {
        return error(400, "Pick when you leave and when you're back.");
    }
    let (from, until) = (from.and_then(Value::as_str).unwrap().to_string(), until.and_then(Value::as_str).unwrap().to_string());
    let label = body.str("label").map(|l| slice(l.trim(), 60));
    let household = user.household().unwrap_or("").to_string();
    try_run!(&hub.store.db(), "UPDATE households SET away_from = ?, away_until = ?, away_label = ? WHERE id = ?",
        p![from, until, label.clone().filter(|l| !l.is_empty()), household]);
    log_activity(&hub, &user, "away.set", "household", None, label.as_deref().unwrap_or(""), json!({ "from": from, "until": until }));
    ok(current_away(&hub, &household))
}

async fn end_away(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if let Err(r) = away_parent(&hub, &user) {
        return r;
    }
    try_run!(&hub.store.db(), "UPDATE households SET away_from = NULL, away_until = NULL, away_label = NULL WHERE id = ?", p![user.household_id.clone()]);
    log_activity(&hub, &user, "away.end", "household", None, "", json!({}));
    no_content()
}

// ---- Summer break -------------------------------------------------------------------------------

/// The summer break, or null when none is set or it has ended.
pub fn summer_break(hub: &Hub, household: &str) -> Value {
    let row = db::one(&hub.store.db(), "SELECT summer_from, summer_until FROM households WHERE id = ?", p![household]);
    let Some(r) = row else { return Value::Null };
    match (db::text(&r, "summer_from"), db::text(&r, "summer_until")) {
        (Some(from), Some(until)) if !from.is_empty() && !until.is_empty() && until >= home_today(hub) => json!({ "from": from, "until": until }),
        _ => Value::Null,
    }
}

fn summer_parent(hub: &Hub, user: &User) -> Result<(), Response> {
    if manages(hub, user, "chores") { Ok(()) } else { Err(error(403, "A parent sets the summer break.")) }
}

async fn get_summer(State(hub): State<Arc<Hub>>, user: User) -> Response {
    ok(summer_break(&hub, user.household().unwrap_or("")))
}

async fn put_summer(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if let Err(r) = summer_parent(&hub, &user) {
        return r;
    }
    let (from, until) = (body.raw("from"), body.raw("until"));
    if !is_iso_date(from) || !is_iso_date(until) || until.and_then(Value::as_str) < from.and_then(Value::as_str) {
        return error(400, "Pick the first and last day of the summer break.");
    }
    let household = user.household().unwrap_or("").to_string();
    try_run!(&hub.store.db(), "UPDATE households SET summer_from = ?, summer_until = ? WHERE id = ?", p![from.cloned(), until.cloned(), household]);
    realtime::broadcast(&hub, &household, "households:updated", json!({}));
    ok(summer_break(&hub, &household))
}

async fn end_summer(State(hub): State<Arc<Hub>>, user: User) -> Response {
    if let Err(r) = summer_parent(&hub, &user) {
        return r;
    }
    let household = user.household().unwrap_or("").to_string();
    try_run!(&hub.store.db(), "UPDATE households SET summer_from = NULL, summer_until = NULL WHERE id = ?", p![household]);
    realtime::broadcast(&hub, &household, "households:updated", json!({}));
    no_content()
}

// ---- Seasons ------------------------------------------------------------------------------------

const HOLIDAY_IDS: [&str; 10] = ["christmas", "halloween", "valentines", "pink-october", "ramadan", "eid-al-adha", "easter", "hanukkah", "diwali", "lunar-new-year"];
const DEFAULT_HOLIDAYS: [&str; 4] = ["christmas", "halloween", "valentines", "pink-october"];
const EFFECTS: [&str; 5] = ["none", "snow", "leaves", "hearts", "embers"];
const MAX_THEMES: usize = 12;

fn str_of(v: Option<&Value>, max: usize) -> String {
    v.and_then(Value::as_str).map(|s| slice(s, max)).unwrap_or_default()
}

/// An imported theme, keeping only the fields the apps read. None if it's not usable.
fn clean_theme(t: &Value) -> Option<Value> {
    let r = t.as_object()?;
    let accent = r.get("accent").filter(|a| db::truthy(Some(a)));
    let name = str_of(r.get("name"), 32).trim().to_string();
    let id = str_of(r.get("id"), 60);
    let (light, dark) = (str_of(accent.and_then(|a| a.get("light")), 80), str_of(accent.and_then(|a| a.get("dark")), 80));
    if name.is_empty() || !id.starts_with("custom-") || accent.is_none() || light.is_empty() || dark.is_empty() {
        return None;
    }
    let svg = r.get("ornamentSvg").and_then(Value::as_str).filter(|s| s.trim().starts_with("<svg") && s.encode_utf16().count() <= 60_000);
    let tint = r.get("tint").and_then(Value::as_f64).filter(|t| t.is_finite()).map(|t| ((t % 360.0) + 360.0) % 360.0).unwrap_or(80.0);
    let effect = r.get("effect").and_then(Value::as_str).filter(|e| EFFECTS.contains(e)).unwrap_or("none");
    let mut out = json!({
        "id": id, "name": name, "tagline": str_of(r.get("tagline"), 80), "accent": { "light": light, "dark": dark },
        "tint": num(tint), "effect": effect, "ornament": if svg.is_some() { "custom" } else { "none" },
    });
    if let Some(s) = svg {
        out["ornamentSvg"] = json!(s);
    }
    out["imported"] = json!(true);
    Some(out)
}

pub fn season_settings(hub: &Hub, household: &str) -> Value {
    let saved = db::one(&hub.store.db(), "SELECT season_settings FROM households WHERE id = ?", p![household])
        .and_then(|r| db::text(&r, "season_settings"))
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null);
    let holidays = match saved.get("holidays") {
        Some(Value::Array(h)) => json!(h.iter().filter(|x| x.as_str().is_some_and(|s| HOLIDAY_IDS.contains(&s))).collect::<Vec<_>>()),
        _ => json!(DEFAULT_HOLIDAYS),
    };
    let themes = match saved.get("themes") {
        Some(t @ Value::Array(_)) => t.clone(),
        _ => json!([]),
    };
    json!({ "holidays": holidays, "themes": themes })
}

async fn get_seasons(State(hub): State<Arc<Hub>>, user: User) -> Response {
    ok(season_settings(&hub, user.household().unwrap_or("")))
}

async fn put_seasons(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if !manages(&hub, &user, "hub") {
        return error(403, "Ask a parent to change the house's seasons.");
    }
    let household = user.household().unwrap_or("").to_string();
    let current = season_settings(&hub, &household);
    let holidays = match body.raw("holidays") {
        Some(Value::Array(h)) => {
            let mut seen: Vec<Value> = Vec::new();
            for x in h.iter().filter(|x| x.as_str().is_some_and(|s| HOLIDAY_IDS.contains(&s))) {
                if !seen.contains(x) {
                    seen.push(x.clone());
                }
            }
            Value::Array(seen)
        }
        _ => current["holidays"].clone(),
    };
    let themes = match body.raw("themes") {
        Some(Value::Array(t)) => Value::Array(t.iter().filter_map(clean_theme).collect()),
        _ => current["themes"].clone(),
    };
    if themes.as_array().map_or(0, Vec::len) > MAX_THEMES {
        return error(400, format!("A house can keep up to {MAX_THEMES} themes."));
    }
    let next = Value::Object(Map::from_iter([("holidays".to_string(), holidays), ("themes".to_string(), themes)]));
    try_run!(&hub.store.db(), "UPDATE households SET season_settings = ? WHERE id = ?", p![next.to_string(), household]);
    realtime::broadcast(&hub, &household, "households:updated", json!({}));
    ok(next)
}
