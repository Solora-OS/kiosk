//! /api/v1/calendars and /api/v1/events (routes/calendars.ts, routes/events.ts).

use crate::auth::User;
use crate::db::{self, defined, is_iso_date, js_string, num, truthy, Row};
use crate::household::{caller_member, log_activity, manages, write_log, LogEntry};
use crate::http::{created, error, no_content, ok, Body};
use crate::{p, try_run, realtime, store, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch};
use axum::Router;
use serde_json::{json, Map, Value};
use std::sync::Arc;

// ---- Calendars ------------------------------------------------------------------------

pub fn calendars() -> Router<Arc<Hub>> {
    Router::new().route("/", get(list_calendars).post(add_calendar)).route("/{id}", patch(edit_calendar).delete(remove_calendar))
}

pub fn row_to_calendar(r: &Row) -> Value {
    json!({ "id": r["id"], "householdId": r["household_id"], "name": r["name"], "color": r["color"], "memberIds": db::json_col(r, "member_ids", json!([])), "createdAt": r["created_at"] })
}

const NOT_CALENDARS: &str = "Ask a parent to change the calendars.";

async fn list_calendars(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM calendars WHERE household_id = ? ORDER BY created_at", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(row_to_calendar).collect()))
}

async fn add_calendar(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_CALENDARS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let Some(name) = body.text("name") else { return error(400, "name is required.") };
    let id = store::uuid();
    let db_ = hub.store.db();
    try_run!(&db_, "INSERT INTO calendars (id, household_id, name, color, member_ids) VALUES (?, ?, ?, ?, ?)",
        p![id, household, name, body.raw("color").cloned().unwrap_or(json!("blue")), body.raw("memberIds").cloned().unwrap_or(json!([])).to_string()]);
    let cal = db::one(&db_, "SELECT * FROM calendars WHERE id = ?", p![id]).map(|r| row_to_calendar(&r)).unwrap_or(Value::Null);
    drop(db_);
    realtime::broadcast(&hub, &household, "calendars:created", cal.clone());
    created(cal)
}

async fn edit_calendar(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_CALENDARS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let db_ = hub.store.db();
    if db::one(&db_, "SELECT id FROM calendars WHERE id = ? AND household_id = ?", p![id, household]).is_none() {
        return error(404, "Calendar not found.");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = body.raw("name") { sets.push("name = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if let Some(v) = body.raw("color") { sets.push("color = ?"); vals.push(db::Bind::bind(v)); }
    if let Some(v) = body.raw("memberIds") { sets.push("member_ids = ?"); vals.push(db::Bind::bind(&v.to_string())); }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    try_run!(&db_, &format!("UPDATE calendars SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    let cal = db::one(&db_, "SELECT * FROM calendars WHERE id = ?", p![id]).map(|r| row_to_calendar(&r)).unwrap_or(Value::Null);
    drop(db_);
    realtime::broadcast(&hub, &household, "calendars:updated", cal.clone());
    ok(cal)
}

async fn remove_calendar(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_CALENDARS);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let db_ = hub.store.db();
    if db::one(&db_, "SELECT id FROM calendars WHERE id = ? AND household_id = ?", p![id, household]).is_none() {
        return error(404, "Calendar not found.");
    }
    try_run!(&db_, "DELETE FROM calendars WHERE id = ? AND household_id = ?", p![id, household]);
    drop(db_);
    realtime::broadcast(&hub, &household, "calendars:deleted", json!(id));
    no_content()
}

// ---- Events ----------------------------------------------------------------------------

pub fn events() -> Router<Arc<Hub>> {
    Router::new().route("/", get(list_events).post(add_event)).route("/{id}", patch(edit_event).delete(remove_event))
}

/// "2,4" → [2, 4]; None when nothing valid.
pub fn parse_repeat_days(v: &Value) -> Option<Vec<i64>> {
    let s = v.as_str().filter(|s| !s.is_empty())?;
    let days: Vec<i64> = s.split(',').filter_map(|d| d.trim().parse::<f64>().ok()).filter(|n| n.fract() == 0.0 && (0.0..=6.0).contains(n)).map(|n| n as i64).collect();
    (!days.is_empty()).then_some(days)
}

/// A repeatDays body field as its column ("2,4" or null).
pub fn repeat_days_column(v: Option<&Value>) -> Option<String> {
    let arr = v?.as_array()?;
    let mut days: Vec<i64> = Vec::new();
    for d in arr {
        let n = js_number(Some(d));
        if n.fract() == 0.0 && (0.0..=6.0).contains(&n) && !days.contains(&(n as i64)) {
            days.push(n as i64);
        }
    }
    days.sort_by_key(|d| d.to_string());
    (!days.is_empty()).then(|| days.iter().map(i64::to_string).collect::<Vec<_>>().join(","))
}

/// `Number(v)`: undefined → NaN, null → 0, "" → 0.
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as i64 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) }
        }
        Some(Value::Array(a)) if a.is_empty() => 0.0,
        Some(Value::Array(a)) if a.len() == 1 => js_number(a.first()),
        Some(_) => f64::NAN,
    }
}

fn skip_dates_column(v: Option<&Value>) -> String {
    let mut dates: Vec<String> = v.and_then(Value::as_array).map(|a| a.iter().filter(|d| is_iso_date(Some(d))).filter_map(|d| d.as_str().map(str::to_string)).collect()).unwrap_or_default();
    dates.sort();
    dates.dedup();
    json!(dates).to_string()
}

/// Minutes before the start to remind (all-day events count from 9 AM); None for no reminder.
fn reminder_column(v: Option<&Value>) -> Option<i64> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        _ => {
            let n = js_number(v);
            (n.fract() == 0.0 && (0.0..=10080.0).contains(&n)).then_some(n as i64)
        }
    }
}

pub fn row_to_event(r: &Row) -> Value {
    let start = { let n = db::number(r, "start_hour"); if n.is_nan() { 0.0 } else { n } };
    let end = { let n = db::number(r, "end_hour"); if n.is_nan() { 0.0 } else { n } };
    let mut e = json!({
        "id": r["id"], "householdId": r["household_id"], "calendarId": db::opt(r, "calendar_id"), "title": r["title"],
        "date": r["date"], "endDate": db::opt(r, "end_date"), "allDay": db::bool(r, "all_day"),
        "repeatDays": parse_repeat_days(&db::opt(r, "repeat_days")).map(|d| json!(d)).unwrap_or(Value::Null),
        "repeatUntil": db::opt(r, "repeat_until"), "skipDates": db::json_col(r, "skip_dates", json!([])),
        "countdown": db::bool(r, "countdown"), "time": db::opt(r, "time"),
        "start": num(start), "end": num(end), "startHour": num(start), "endHour": num(end),
        "memberIds": db::json_col(r, "member_ids", json!([])), "location": db::opt(r, "location"), "createdAt": r["created_at"],
        "source": db::opt(r, "source"),
        "reminderMinutes": if r.get("remind_minutes").is_none_or(Value::is_null) { Value::Null } else { num(db::number(r, "remind_minutes")) },
        "createdBy": db::opt(r, "created_by"),
    });
    e = defined(e, &["id", "householdId", "title", "date", "createdAt", "reminderMinutes", "createdBy"]);
    e
}

const NOT_YOURS: &str = "Only whoever added this event, or a parent, can change it.";

/// Who may change an event: anyone who manages the calendar, and whoever added it.
fn may_change(hub: &Hub, user: &User, r: &Row) -> bool {
    manages(hub, user, "calendar") || caller_member(hub, user).is_some_and(|m| db::text(r, "created_by").as_deref() == Some(m.id.as_str()))
}

fn pick<'a>(body: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|k| body.get(*k))
}
fn has(body: &Map<String, Value>, keys: &[&str]) -> bool {
    keys.iter().any(|k| body.contains_key(*k))
}

struct Times {
    date: String,
    end_date: Option<String>,
    all_day: bool,
    start: f64,
    end: f64,
}

/// Hours since midnight, clamped to the day and rounded to the minute.
fn to_hour(v: Option<&Value>, fallback: f64) -> f64 {
    let n = js_number(v);
    if n.is_finite() { (((n * 60.0).round()) / 60.0).clamp(0.0, 24.0) } else { fallback }
}

/// resolveTimes: all-day spans the day, an end date on/before the start is
/// dropped, a same-day event always ends after it starts. Accepts the
/// phone's start/end, the kiosk's snake_case, and older startHour.
fn resolve_times(body: &Map<String, Value>, base: Times) -> Times {
    let date = if is_iso_date(body.get("date")) { body["date"].as_str().unwrap().to_string() } else { base.date };
    let all_day = if has(body, &["allDay", "all_day"]) { truthy(pick(body, &["allDay", "all_day"])) } else { base.all_day };
    let end_raw = if has(body, &["endDate", "end_date"]) { pick(body, &["endDate", "end_date"]).cloned() } else { base.end_date.map(Value::String) };
    let end_date = end_raw.filter(|v| is_iso_date(Some(v))).and_then(|v| v.as_str().map(str::to_string)).filter(|e| e.as_str() > date.as_str());
    if all_day {
        return Times { date, end_date, all_day, start: 0.0, end: 24.0 };
    }
    let start = to_hour(pick(body, &["start", "startHour", "start_hour"]), base.start);
    let mut end = to_hour(pick(body, &["end", "endHour", "end_hour"]), base.end);
    if end_date.is_none() && end <= start {
        end = (start + 1.0).min(24.0);
    }
    Times { date, end_date, all_day, start, end }
}

/// "17:30": the legacy display column.
fn clock_column(t: &Times) -> Option<String> {
    if t.all_day {
        return None;
    }
    let mins = (t.start * 60.0).round() as i64;
    Some(format!("{:02}:{:02}", (mins / 60) % 24, mins % 60))
}

async fn list_events(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM events WHERE household_id = ? ORDER BY date, start_hour", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(row_to_event).collect()))
}

async fn add_event(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let b = body.0.as_object().cloned().unwrap_or_default();
    let title = b.get("title").and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
    if title.is_empty() || !is_iso_date(b.get("date")) {
        return error(400, "title and date (yyyy-mm-dd) are required.");
    }
    let date = b["date"].as_str().unwrap().to_string();
    let t = resolve_times(&b, Times { date: date.clone(), end_date: None, all_day: false, start: 9.0, end: 10.0 });
    let me = caller_member(&hub, &user);
    let is_manager = manages(&hub, &user, "calendar");
    if !is_manager && me.is_none() {
        return error(403, "Ask a parent to add this event.");
    }
    let member_ids = if is_manager { pick(&b, &["memberIds", "member_ids"]).cloned().filter(Value::is_array).unwrap_or(json!([])) } else { json!([me.as_ref().unwrap().id]) };
    let calendar_id = pick(&b, &["calendarId", "calendar_id"]).filter(|v| truthy(Some(v))).cloned();
    let location = b.get("location").filter(|v| truthy(Some(v))).cloned();
    let repeat_days = repeat_days_column(pick(&b, &["repeatDays", "repeat_days"]));
    let until = pick(&b, &["repeatUntil", "repeat_until"]);
    let until = if repeat_days.is_some() && is_iso_date(until) && until.and_then(Value::as_str).unwrap_or("") >= t.date.as_str() { until.cloned() } else { None };
    let id = store::uuid();
    let db_ = hub.store.db();
    try_run!(
        &db_,
        "INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, member_ids, location,
           repeat_days, repeat_until, skip_dates, countdown, remind_minutes, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        p![
            id, household, calendar_id, title, t.date.clone(), t.end_date.clone(), t.all_day, clock_column(&t), t.start, t.end, member_ids.to_string(), location,
            repeat_days, until, skip_dates_column(pick(&b, &["skipDates", "skip_dates"])), truthy(b.get("countdown")),
            reminder_column(pick(&b, &["reminderMinutes", "remind_minutes"])), me.map(|m| m.id),
        ],
    );
    let event = db::one(&db_, "SELECT * FROM events WHERE id = ?", p![id]).map(|r| row_to_event(&r)).unwrap_or(Value::Null);
    drop(db_);
    log_activity(&hub, &user, "event.create", "event", Some(&id), &title, json!({}));
    realtime::broadcast(&hub, &household, "events:created", event.clone());
    created(event)
}

async fn edit_event(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let existing = db::one(&hub.store.db(), "SELECT * FROM events WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(existing) = existing else { return error(404, "Event not found.") };
    if !may_change(&hub, &user, &existing) {
        return error(403, NOT_YOURS);
    }
    let mut b = body.0.as_object().cloned().unwrap_or_default();
    if !manages(&hub, &user, "calendar") {
        b.remove("memberIds");
        b.remove("member_ids");
    }
    let (mut sets, mut vals) = (Vec::<&str>::new(), Vec::new());
    if let Some(v) = b.get("title") { sets.push("title = ?"); vals.push(db::Bind::bind(&js_string(v).trim().to_string())); }
    if has(&b, &["date", "endDate", "end_date", "allDay", "all_day", "start", "startHour", "start_hour", "end", "endHour", "end_hour"]) {
        let cur = row_to_event(&existing);
        let base = Times {
            date: cur["date"].as_str().unwrap_or("").to_string(),
            end_date: cur.get("endDate").and_then(Value::as_str).map(str::to_string),
            all_day: cur["allDay"].as_bool().unwrap_or(false),
            start: cur["start"].as_f64().unwrap_or(0.0),
            end: cur["end"].as_f64().unwrap_or(0.0),
        };
        let t = resolve_times(&b, base);
        sets.extend(["date = ?", "end_date = ?", "all_day = ?", "time = ?", "start_hour = ?", "end_hour = ?"]);
        vals.extend(p![t.date.clone(), t.end_date.clone(), t.all_day, clock_column(&t), t.start, t.end]);
    }
    if has(&b, &["memberIds", "member_ids"]) {
        let m = pick(&b, &["memberIds", "member_ids"]).cloned().filter(Value::is_array).unwrap_or(json!([]));
        sets.push("member_ids = ?");
        vals.push(db::Bind::bind(&m.to_string()));
    }
    if has(&b, &["calendarId", "calendar_id"]) { sets.push("calendar_id = ?"); vals.push(db::Bind::bind(&pick(&b, &["calendarId", "calendar_id"]).filter(|v| truthy(Some(v))).cloned())); }
    if b.contains_key("location") { sets.push("location = ?"); vals.push(db::Bind::bind(&b.get("location").filter(|v| truthy(Some(v))).cloned())); }
    if b.contains_key("countdown") { sets.push("countdown = ?"); vals.push(db::Bind::bind(&truthy(b.get("countdown")))); }
    if has(&b, &["reminderMinutes", "remind_minutes"]) { sets.push("remind_minutes = ?"); vals.push(db::Bind::bind(&reminder_column(pick(&b, &["reminderMinutes", "remind_minutes"])))); }
    let repeat_days: Option<Option<String>> = has(&b, &["repeatDays", "repeat_days"]).then(|| repeat_days_column(pick(&b, &["repeatDays", "repeat_days"])));
    if let Some(r) = &repeat_days { sets.push("repeat_days = ?"); vals.push(db::Bind::bind(r)); }
    if repeat_days == Some(None) {
        sets.extend(["repeat_until = ?", "skip_dates = ?"]);
        vals.extend(p![Option::<String>::None, "[]"]);
    } else if has(&b, &["repeatUntil", "repeat_until"]) {
        let until = pick(&b, &["repeatUntil", "repeat_until"]);
        sets.push("repeat_until = ?");
        vals.push(db::Bind::bind(&until.filter(|u| is_iso_date(Some(u))).cloned()));
    }
    if repeat_days != Some(None) && has(&b, &["skipDates", "skip_dates"]) {
        sets.push("skip_dates = ?");
        vals.push(db::Bind::bind(&skip_dates_column(pick(&b, &["skipDates", "skip_dates"]))));
    }
    if sets.is_empty() {
        return error(400, "No fields to update.");
    }
    vals.extend(p![id, household]);
    let db_ = hub.store.db();
    try_run!(&db_, &format!("UPDATE events SET {} WHERE id = ? AND household_id = ?", sets.join(", ")), vals);
    let event = db::one(&db_, "SELECT * FROM events WHERE id = ?", p![id]).map(|r| row_to_event(&r)).unwrap_or(Value::Null);
    drop(db_);
    log_activity(&hub, &user, "event.update", "event", Some(&id), event["title"].as_str().unwrap_or(""), json!({}));
    realtime::broadcast(&hub, &household, "events:updated", event.clone());
    ok(event)
}

async fn remove_event(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    let household = user.household_id.clone().unwrap_or_default();
    let row = db::one(&hub.store.db(), "SELECT * FROM events WHERE id = ? AND household_id = ?", p![id, household]);
    let Some(row) = row else { return error(404, "Event not found.") };
    if !may_change(&hub, &user, &row) {
        return error(403, NOT_YOURS);
    }
    try_run!(&hub.store.db(), "DELETE FROM events WHERE id = ? AND household_id = ?", p![id, household]);
    realtime::broadcast(&hub, &household, "events:deleted", json!(id));
    write_log(&hub, LogEntry { household_id: &household, actor_id: Some(&user.sub), actor_name: None, action: "event.delete", resource_type: "event", resource_id: Some(&id), resource_name: &db::s(&row, "title"), metadata: json!({}) });
    no_content()
}
