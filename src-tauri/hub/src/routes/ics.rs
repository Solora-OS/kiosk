//! The family calendar as an iCal feed (routes/ics.ts): calendar apps on the
//! home network subscribe to /ics/<token>, where the token is an HMAC of the
//! household id, so only someone given the link can read it.

use crate::auth::User;
use crate::db::{self};
use crate::hometime::{add_days_iso, home_instant};
use crate::http::{error, lan_base_url, ok};
use crate::{p, Hub};
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use chrono::{Datelike, TimeZone, Timelike, Utc};
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::sync::Arc;

pub fn ics_token(hub: &Hub, household_id: &str) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(hub.store.secret().as_bytes()).expect("any key length");
    mac.update(household_id.as_bytes());
    hex::encode(mac.finalize().into_bytes())[..32].to_string()
}

fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace('\n', "\\n")
}

const DAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/// DTSTART/DTEND for a home date plus hours since midnight, in UTC.
fn date_time(hub: &Hub, date: &str, hour: f64) -> String {
    let t = Utc.timestamp_millis_opt(home_instant(hub, date, hour, None)).single().unwrap_or_else(Utc::now);
    format!("{:04}{:02}{:02}T{:02}{:02}00Z", t.year(), t.month(), t.day(), t.hour(), t.minute())
}

/// The feed's address on the home network (phones and computers at home can
/// subscribe; Google's servers on the internet can't reach it).
fn feed_link(hub: &Hub, household_id: &str) -> Option<Value> {
    let lan = lan_base_url(hub.config.port)?;
    let url = format!("{}/ics/{}", lan.trim_end_matches("/api/v1"), ics_token(hub, household_id));
    let webcal = url.replacen("http://", "webcal://", 1).replacen("https://", "webcal://", 1);
    Some(json!({ "url": url, "webcalUrl": webcal }))
}

pub async fn token(State(hub): State<Arc<Hub>>, user: User, Path(household_id): Path<String>) -> Response {
    if user.household_id.as_deref() != Some(household_id.as_str()) {
        return error(403, "Forbidden.");
    }
    if db::one(&hub.store.db(), "SELECT id FROM households WHERE id=?", p![household_id]).is_none() {
        return error(404, "Not found.");
    }
    let mut out = json!({ "token": ics_token(&hub, &household_id), "householdId": household_id });
    if let (Value::Object(o), Some(Value::Object(link))) = (&mut out, feed_link(&hub, &household_id)) {
        o.extend(link);
    }
    ok(out)
}

pub async fn link(State(hub): State<Arc<Hub>>, user: User) -> Response {
    match feed_link(&hub, user.household().unwrap_or("")) {
        Some(mut l) => {
            l["homeNetworkOnly"] = json!(true);
            ok(l)
        }
        None => error(503, "The hub isn't on a network right now."),
    }
}

fn not_found_text() -> Response {
    (StatusCode::NOT_FOUND, [(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"))], "Not found.").into_response()
}

pub async fn feed(State(hub): State<Arc<Hub>>, Path(token): Path<String>) -> Response {
    let households = db::all(&hub.store.db(), "SELECT id, name FROM households", p![]);
    let found = households.into_iter().find(|h| {
        let candidate = ics_token(&hub, &db::s(h, "id"));
        candidate.len() == token.len() && candidate.bytes().zip(token.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
    });
    let Some(household) = found else { return not_found_text() };
    let (id, name) = (db::s(&household, "id"), db::s(&household, "name"));
    let events = db::all(&hub.store.db(),
        "SELECT id, title, date, end_date, all_day, repeat_days, repeat_until, skip_dates, start_hour, end_hour, location FROM events WHERE household_id=? ORDER BY date, start_hour", p![id]);
    let stamp = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(), "VERSION:2.0".into(), "PRODID:-//Solora//Solora Hub//EN".into(),
        format!("X-WR-CALNAME:{}", escape(&name)), "CALSCALE:GREGORIAN".into(), "METHOD:PUBLISH".into(),
    ];
    for e in &events {
        let date = db::s(e, "date");
        let last = db::text(e, "end_date").unwrap_or_else(|| date.clone());
        let all_day = db::number(e, "all_day") != 0.0;
        let (start, end) = (db::number(e, "start_hour"), db::number(e, "end_hour"));
        lines.push("BEGIN:VEVENT".into());
        lines.push(format!("UID:{}@lumora", db::s(e, "id")));
        lines.push(format!("DTSTAMP:{stamp}"));
        if all_day {
            lines.push(format!("DTSTART;VALUE=DATE:{}", date.replace('-', "")));
            lines.push(format!("DTEND;VALUE=DATE:{}", add_days_iso(&last, 1).replace('-', "")));
        } else {
            lines.push(format!("DTSTART:{}", date_time(&hub, &date, start)));
            lines.push(format!("DTEND:{}", date_time(&hub, &last, end)));
        }
        lines.push(format!("SUMMARY:{}", escape(&db::s(e, "title"))));
        if let Some(days) = db::text(e, "repeat_days").filter(|d| !d.is_empty()) {
            let by_day: Vec<&str> = days.split(',').map(|d| d.trim().parse::<usize>().ok().and_then(|i| DAYS.get(i).copied()).unwrap_or("undefined")).collect();
            let until = db::text(e, "repeat_until")
                .map(|u| format!(";UNTIL={}", if all_day { u.replace('-', "") } else { date_time(&hub, &u, 24.0) }))
                .unwrap_or_default();
            lines.push(format!("RRULE:FREQ=WEEKLY;BYDAY={}{until}", by_day.join(",")));
            for skip in db::json_col(e, "skip_dates", json!([])).as_array().into_iter().flatten().filter_map(Value::as_str) {
                lines.push(if all_day { format!("EXDATE;VALUE=DATE:{}", skip.replace('-', "")) } else { format!("EXDATE:{}", date_time(&hub, skip, start)) });
            }
        }
        if let Some(loc) = db::text(e, "location").filter(|l| !l.is_empty()) {
            lines.push(format!("LOCATION:{}", escape(&loc)));
        }
        lines.push("END:VEVENT".into());
    }
    lines.push("END:VCALENDAR".into());
    let disposition = format!("attachment; filename=\"{name}.ics\"");
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("text/calendar; charset=utf-8")),
            (header::CONTENT_DISPOSITION, HeaderValue::from_str(&disposition).unwrap_or(HeaderValue::from_static("attachment"))),
        ],
        lines.join("\r\n"),
    )
        .into_response()
}

