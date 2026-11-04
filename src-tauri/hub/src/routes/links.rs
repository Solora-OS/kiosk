//! Calendars the family subscribes to by link (services/calendar-links.ts,
//! routes/calendar-links.ts): a school's holidays, a sports league.
//!
//! The hub fetches each iCal link (https:// or webcal://), reads its events
//! and keeps them in `events` with source "ics", re-reading every hour; what
//! the publisher removes disappears here too. Times arrive in the feed's zone
//! (UTC, a TZID, or floating) and are stored as home wall-clock times. Weekly
//! and daily repeats become Solora repeats (with skipped dates); other repeats
//! are written out as single events for the next year.

use crate::auth::User;
use crate::db::{self, Row};
use crate::hometime::{add_days_iso, home_instant, home_time_zone, home_today, weekday};
use crate::household::manages;
use crate::http::{created, error, no_content, ok, Body};
use crate::{p, realtime, store, try_run, Hub};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::{get, patch, post};
use axum::Router;
use chrono::{Datelike, NaiveDate, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

const FETCH_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_BYTES: usize = 5 * 1024 * 1024;
/// Past events older than this aren't imported; future ones up to a year and a bit.
const KEEP_PAST_DAYS: i64 = 30;
const EXPAND_DAYS: i64 = 400;
const DAYS: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// ---- Reading iCal -----------------------------------------------------------------------

#[derive(Clone)]
struct Prop {
    name: String,
    params: HashMap<String, String>,
    value: String,
}
type VEvent = Vec<Prop>;

/// Unfold continuation lines and split into properties.
fn lines(text: &str) -> Vec<String> {
    let unfolded = text.replace("\r\n ", "").replace("\r\n\t", "").replace("\n ", "").replace("\n\t", "");
    unfolded.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l).to_string()).collect()
}

fn parse_prop(line: &str) -> Option<Prop> {
    // The value starts at the first colon outside a quoted parameter.
    let mut quoted = false;
    let mut at = None;
    for (i, c) in line.char_indices() {
        if c == '"' {
            quoted = !quoted;
        } else if c == ':' && !quoted {
            at = Some(i);
            break;
        }
    }
    let at = at?;
    let mut parts = line[..at].split(';');
    let name = parts.next().unwrap_or("").to_uppercase();
    let mut params = HashMap::new();
    for p in parts {
        if let Some(eq) = p.find('=').filter(|e| *e > 0) {
            let v = &p[eq + 1..];
            let v = v.strip_prefix('"').unwrap_or(v);
            let v = v.strip_suffix('"').unwrap_or(v);
            params.insert(p[..eq].to_uppercase(), v.to_string());
        }
    }
    Some(Prop { name, params, value: line[at + 1..].to_string() })
}

fn unescape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.peek() {
                Some('n') | Some('N') => { chars.next(); out.push('\n'); continue; }
                Some(&n @ (',' | ';' | '\\')) => { chars.next(); out.push(n); continue; }
                _ => {}
            }
        }
        out.push(c);
    }
    out.trim().to_string()
}

fn parse_calendar(text: &str) -> (Option<String>, Vec<VEvent>) {
    let mut name = None;
    let mut events = Vec::new();
    let mut current: Option<VEvent> = None;
    let mut depth = 0; // nested blocks (VALARM) inside an event
    for line in lines(text) {
        if line.is_empty() {
            continue;
        }
        let Some(p) = parse_prop(&line) else { continue };
        if p.name == "BEGIN" {
            if p.value.eq_ignore_ascii_case("VEVENT") { current = Some(Vec::new()); depth = 0; } else if current.is_some() { depth += 1; }
            continue;
        }
        if p.name == "END" {
            if p.value.eq_ignore_ascii_case("VEVENT") && current.is_some() { events.push(current.take().unwrap()); } else if current.is_some() { depth -= 1; }
            continue;
        }
        match current.as_mut() {
            Some(c) if depth == 0 => c.push(p),
            None if p.name == "X-WR-CALNAME" => name = Some(unescape_text(&p.value)),
            _ => {}
        }
    }
    (name, events)
}

fn prop<'a>(e: &'a VEvent, name: &str) -> Option<&'a Prop> {
    e.iter().find(|p| p.name == name)
}

fn zone(tz: Option<&String>) -> Option<Tz> {
    tz.and_then(|t| t.parse().ok())
}

/// Home wall-clock date and hour for an instant.
fn home_wall(ms: i64, tz: &str) -> (String, f64) {
    let tz: Tz = tz.parse().unwrap_or(Tz::UTC);
    let t = Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now).with_timezone(&tz);
    (format!("{:04}-{:02}-{:02}", t.year(), t.month(), t.day()), t.hour() as f64 + t.minute() as f64 / 60.0)
}

#[derive(Clone)]
enum When {
    Day(String),
    At(i64),
}

/// A DTSTART/DTEND/EXDATE/RECURRENCE-ID value: a whole day, or an instant.
fn read_when(hub: &Hub, p: &Prop, value: &str, home: &str) -> Option<When> {
    let b = value.as_bytes();
    let digits = |r: std::ops::Range<usize>| b.get(r.clone()).filter(|s| s.iter().all(u8::is_ascii_digit)).map(|s| std::str::from_utf8(s).unwrap().parse::<i64>().unwrap());
    let (y, mo, d) = (digits(0..4)?, digits(4..6)?, digits(6..8)?);
    let date = format!("{:04}-{:02}-{:02}", y, mo, d);
    let rest = &value[8..];
    if rest.is_empty() {
        return Some(When::Day(date));
    }
    // T hh mm [ss] [Z]
    let rb = rest.as_bytes();
    if rb[0] != b'T' || rest.len() < 5 {
        return None;
    }
    let num = |s: &[u8]| -> Option<i64> { s.iter().all(u8::is_ascii_digit).then(|| std::str::from_utf8(s).unwrap().parse().unwrap()) };
    let (h, m) = (num(&rb[1..3])?, num(&rb[3..5])?);
    let mut i = 5;
    let mut sec = 0;
    if rb.len() >= 7 && rb[5].is_ascii_digit() {
        sec = num(&rb[5..7])?;
        i = 7;
    }
    let z = match &rest[i..] {
        "" => false,
        "Z" => true,
        _ => return None,
    };
    if p.params.get("VALUE").map(String::as_str) == Some("DATE") {
        return Some(When::Day(date));
    }
    let hour = h as f64 + m as f64 / 60.0 + sec as f64 / 3600.0;
    if z {
        let midnight = NaiveDate::from_ymd_opt(y as i32, mo as u32, d as u32)?.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis();
        return Some(When::At(midnight + (hour * 3_600_000.0) as i64));
    }
    // A named zone, or floating time ("wherever you are"): home.
    let tz = if zone(p.params.get("TZID")).is_some() { p.params.get("TZID").cloned() } else { Some(home.to_string()) };
    Some(When::At(home_instant(hub, &date, hour, tz.as_deref())))
}

/// "PT1H30M", "P1D" → milliseconds.
fn duration(v: Option<&str>) -> Option<i64> {
    let v = v?.strip_prefix('P')?;
    let (date_part, time_part) = match v.split_once('T') {
        Some((d, t)) => (d, Some(t)),
        None => (v, None),
    };
    let mut total = 0i64;
    let mut take = |s: &str, units: &[(char, i64)]| -> Option<()> {
        let mut num = String::new();
        let mut order = 0;
        for c in s.chars() {
            if c.is_ascii_digit() {
                num.push(c);
            } else {
                let idx = units.iter().position(|(u, _)| *u == c)?;
                if idx < order || num.is_empty() { return None; }
                order = idx + 1;
                total += num.parse::<i64>().ok()? * units[idx].1;
                num.clear();
            }
        }
        num.is_empty().then_some(())
    };
    take(date_part, &[('W', 7 * 86_400), ('D', 86_400)])?;
    if let Some(t) = time_part {
        take(t, &[('H', 3600), ('M', 60), ('S', 1)])?;
    }
    Some(total * 1000)
}

#[derive(Clone)]
pub struct LinkedEvent {
    key: String,
    title: String,
    location: Option<String>,
    date: String,
    end_date: Option<String>,
    all_day: bool,
    start: f64,
    end: f64,
    repeat_days: Option<Vec<i64>>,
    repeat_until: Option<String>,
    skip_dates: Vec<String>,
}

/// An event as the feed describes it, in its own zone, so repeats can be
/// worked out the way the publisher meant them before becoming home time.
struct Template {
    title: String,
    location: Option<String>,
    all_day: bool,
    local_date: String,
    local_hour: f64,
    tz: String,
    duration_ms: i64,
    span_days: i64,
}

fn days_between(a: &str, b: &str) -> i64 {
    let p = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap_or_default();
    (p(b) - p(a)).num_days()
}

fn template(hub: &Hub, e: &VEvent, home: &str) -> Option<Template> {
    let start_prop = prop(e, "DTSTART")?;
    let start = read_when(hub, start_prop, &start_prop.value, home)?;
    let title = Some(unescape_text(prop(e, "SUMMARY").map(|p| p.value.as_str()).unwrap_or(""))).filter(|t| !t.is_empty()).unwrap_or_else(|| "(No title)".into());
    let location = prop(e, "LOCATION").and_then(|p| Some(unescape_text(&p.value)).filter(|l| !l.is_empty()));
    let end = prop(e, "DTEND").and_then(|p| read_when(hub, p, &p.value, home));
    match start {
        When::Day(date) => {
            // DTEND is exclusive for whole days.
            let last = match &end { Some(When::Day(d)) => add_days_iso(d, -1), _ => date.clone() };
            let span = if last > date { days_between(&date, &last) } else { 0 };
            Some(Template { title, location, all_day: true, local_date: date, local_hour: 0.0, tz: home.into(), duration_ms: 0, span_days: span })
        }
        When::At(ms) => {
            let tz = if start_prop.value.ends_with('Z') { "UTC".to_string() } else if zone(start_prop.params.get("TZID")).is_some() { start_prop.params["TZID"].clone() } else { home.to_string() };
            let (local_date, local_hour) = home_wall(ms, &tz);
            let end_ms = match end {
                Some(When::At(e)) => e,
                _ => ms + duration(prop(e, "DURATION").map(|p| p.value.as_str())).unwrap_or(3_600_000),
            };
            Some(Template { title, location, all_day: false, local_date, local_hour, tz, duration_ms: (end_ms - ms).max(0), span_days: 0 })
        }
    }
}

/// The occurrence that starts on the feed's local date `day`, in home time.
fn occurrence(hub: &Hub, t: &Template, day: &str, home: &str, key: String) -> LinkedEvent {
    let base = |date: String, end_date: Option<String>, start: f64, end: f64| LinkedEvent {
        key: key.clone(), title: t.title.clone(), location: t.location.clone(), date, end_date, all_day: t.all_day, start, end,
        repeat_days: None, repeat_until: None, skip_dates: Vec::new(),
    };
    if t.all_day {
        return base(day.into(), (t.span_days != 0).then(|| add_days_iso(day, t.span_days)), 0.0, 24.0);
    }
    let start_ms = home_instant(hub, day, t.local_hour, Some(&t.tz));
    let (sd, sh) = home_wall(start_ms, home);
    let (mut fd, mut fh) = home_wall(start_ms + t.duration_ms, home);
    // Ending at midnight means the end of the day before, not the start of the next.
    if fh == 0.0 && fd > sd {
        fd = add_days_iso(&fd, -1);
        fh = 24.0;
    }
    let end_date = (fd > sd).then_some(fd);
    base(sd, end_date, sh, fh)
}

fn day_of(w: &When, home: &str) -> String {
    match w {
        When::Day(d) => d.clone(),
        When::At(ms) => home_wall(*ms, home).0,
    }
}

/// A date from (year, 0-based month, day), overflowing like Date.UTC.
fn utc_date(y: i64, month0: i64, d: i64) -> NaiveDate {
    let total = y * 12 + month0;
    let (yy, mm) = (total.div_euclid(12), total.rem_euclid(12));
    NaiveDate::from_ymd_opt(yy as i32, mm as u32 + 1, 1).unwrap_or_default() + chrono::Duration::days(d - 1)
}

/// Turn a feed's events into Solora events, in home time.
fn to_linked_events(hub: &Hub, vevents: &[VEvent], today: &str) -> Vec<LinkedEvent> {
    let home = home_time_zone(hub);
    let from = add_days_iso(today, -KEEP_PAST_DAYS);
    let to = add_days_iso(today, EXPAND_DAYS);
    let mut out: Vec<LinkedEvent> = Vec::new();
    // Moved or cancelled single occurrences of a series, by series UID (as home dates).
    let mut overrides: HashMap<String, Vec<String>> = HashMap::new();
    let in_window = |d: &str| d >= from.as_str() && d <= to.as_str();

    for e in vevents {
        let uid = prop(e, "UID").map(|p| p.value.clone()).unwrap_or_default();
        let recur = prop(e, "RECURRENCE-ID");
        let cancelled = prop(e, "STATUS").is_some_and(|p| p.value.to_uppercase() == "CANCELLED");
        let t = template(hub, e, &home);
        if let (Some(recur), false) = (recur, uid.is_empty()) {
            let original = read_when(hub, recur, &recur.value, &home);
            if let Some(o) = &original {
                overrides.entry(uid.clone()).or_default().push(day_of(o, &home));
            }
            let Some(t) = t.filter(|_| !cancelled) else { continue };
            let o = occurrence(hub, &t, &t.local_date, &home, String::new());
            if in_window(&o.date) {
                let at = original.as_ref().map(|w| day_of(w, &home)).unwrap_or_else(|| o.date.clone());
                out.push(LinkedEvent { key: format!("{uid}@{at}"), ..o });
            }
            continue;
        }
        let Some(t) = t.filter(|_| !cancelled) else { continue };
        let first = occurrence(hub, &t, &t.local_date, &home, String::new());
        let key = if uid.is_empty() { format!("{}@{}", t.title, first.date) } else { uid.clone() };
        let skips: Vec<String> = e
            .iter()
            .filter(|p| p.name == "EXDATE")
            .flat_map(|p| p.value.split(',').filter_map(|v| read_when(hub, p, v, &home)).map(|w| day_of(&w, &home)).collect::<Vec<_>>())
            .collect();
        let rule: HashMap<String, String> = prop(e, "RRULE")
            .map(|p| p.value.split(';').filter(|s| !s.is_empty()).filter_map(|kv| kv.split_once('=').map(|(k, v)| (k.to_string(), v.to_string()))).collect())
            .unwrap_or_default();
        let Some(freq) = rule.get("FREQ").cloned() else {
            if first.end_date.as_deref().unwrap_or(&first.date) >= from.as_str() && first.date <= to {
                out.push(LinkedEvent { key, ..first });
            }
            continue;
        };
        let interval: i64 = rule.get("INTERVAL").map(|i| i.parse().unwrap_or(0)).unwrap_or(1);
        let until_when = rule.get("UNTIL").and_then(|u| {
            let prop = Prop { name: "UNTIL".into(), params: if u.len() == 8 { HashMap::from([("VALUE".into(), "DATE".into())]) } else { HashMap::new() }, value: u.clone() };
            read_when(hub, &prop, u, &home)
        });
        // UNTIL in the feed's own calendar, so it lines up with local occurrence dates.
        let local_until = until_when.map(|w| match w { When::Day(d) => d, When::At(ms) => home_wall(ms, &t.tz).0 });
        let by_day: Vec<i64> = rule
            .get("BYDAY")
            .map(|b| b.split(',').filter_map(|d| DAYS.iter().position(|x| *x == d.trim_start_matches(['+', '-']).trim_start_matches(|c: char| c.is_ascii_digit())).map(|i| i as i64)).collect())
            .unwrap_or_default();
        let count: Option<f64> = rule.get("COUNT").map(|c| c.parse().unwrap_or(f64::NAN));

        if (freq == "WEEKLY" || freq == "DAILY") && interval == 1 {
            let local_days: Vec<i64> = if freq == "DAILY" { (0..7).collect() } else if !by_day.is_empty() { by_day } else { vec![weekday(&t.local_date) as i64] };
            // When home is far enough ahead or behind to change the date, the weekdays move with it.
            let shift = days_between(&t.local_date, &first.date);
            let mut home_days: Vec<i64> = local_days.iter().map(|d| ((d + shift) % 7 + 7) % 7).collect::<HashSet<_>>().into_iter().collect();
            home_days.sort_by_key(|d| d.to_string());
            let mut until = local_until.map(|u| add_days_iso(&u, shift));
            // `rule.COUNT && !until`: any COUNT string counts, even "0".
            if let (Some(c), None) = (count.filter(|_| rule.get("COUNT").is_some_and(|c| !c.is_empty())), &until) {
                until = Some(add_days_iso(&first.date, (c / local_days.len() as f64).ceil() as i64 * 7 - 1));
            }
            if until.as_ref().is_some_and(|u| u.as_str() < from.as_str()) {
                continue;
            }
            out.push(LinkedEvent { key, repeat_days: Some(home_days), repeat_until: until, skip_dates: skips, ..first });
            continue;
        }

        // Anything else is worked out in the feed's calendar and written out as single events.
        let count = count.filter(|_| rule.get("COUNT").is_some_and(|c| !c.is_empty())).unwrap_or(f64::INFINITY);
        let local_to = add_days_iso(&to, 2);
        let mut made = 0f64;
        let emit = |day: &str, out: &mut Vec<LinkedEvent>| {
            let o = occurrence(hub, &t, day, &home, String::new());
            if in_window(&o.date) && !skips.contains(&o.date) {
                out.push(LinkedEvent { key: format!("{key}#{}", o.date), ..o });
            }
        };
        // "First Monday of the month" (BYDAY=1MO), "last Friday" (BYDAY=-1FR).
        let nth = if freq == "MONTHLY" {
            rule.get("BYDAY").and_then(|b| {
                let (sign, rest) = match b.as_bytes().first() { Some(b'+') => (1, &b[1..]), Some(b'-') => (-1, &b[1..]), _ => (1, b.as_str()) };
                (rest.len() == 3 && rest.as_bytes()[0].is_ascii_digit() && rest[1..].bytes().all(|c| c.is_ascii_uppercase()))
                    .then(|| (sign * (rest.as_bytes()[0] - b'0') as i64, DAYS.iter().position(|d| *d == &rest[1..]).map(|i| i as i64).unwrap_or(-1)))
            })
        } else {
            None
        };
        if let Some((n, wd)) = nth {
            let (y0, m0) = (t.local_date[..4].parse::<i64>().unwrap_or(0), t.local_date[5..7].parse::<i64>().unwrap_or(1));
            let mut k = 0;
            while made < count && k < 240 {
                let first_of_month = utc_date(y0, m0 - 1 + k, 1);
                k += interval.max(1);
                let (y, mo) = (first_of_month.year() as i64, first_of_month.month0() as i64);
                let last_day = (utc_date(y, mo + 1, 1) - chrono::Duration::days(1)).day() as i64;
                let first_wd = first_of_month.weekday().num_days_from_sunday() as i64;
                let last_wd = utc_date(y, mo, last_day).weekday().num_days_from_sunday() as i64;
                let dom = if n > 0 { 1 + ((wd - first_wd + 7) % 7) + (n - 1) * 7 } else { last_day - ((last_wd - wd + 7) % 7) + (n + 1) * 7 };
                if dom < 1 || dom > last_day {
                    continue;
                }
                let day = format!("{:04}-{:02}-{:02}", y, mo + 1, dom);
                if day < t.local_date {
                    continue;
                }
                if day > local_to || local_until.as_ref().is_some_and(|u| &day > u) {
                    break;
                }
                made += 1.0;
                emit(&day, &mut out);
            }
            continue;
        }
        let mut day = t.local_date.clone();
        let mut n = 0;
        while made < count && n < 1000 && day <= local_to && local_until.as_ref().is_none_or(|u| &day <= u) {
            emit(&day, &mut out);
            made += 1.0;
            n += 1;
            let (y, mo, d) = (day[..4].parse::<i64>().unwrap_or(0), day[5..7].parse::<i64>().unwrap_or(1), day[8..10].parse::<i64>().unwrap_or(1));
            day = match freq.as_str() {
                "YEARLY" => format!("{}-{:02}-{:02}", y + interval, mo, d),
                "MONTHLY" => utc_date(y, mo - 1 + interval, d).format("%Y-%m-%d").to_string(),
                f => add_days_iso(&day, if f == "WEEKLY" { 7 } else { 1 } * interval),
            };
        }
    }

    // A moved or cancelled occurrence comes off its series.
    for ev in out.iter_mut() {
        if let (Some(moved), true) = (overrides.get(&ev.key), ev.repeat_days.is_some()) {
            let mut all: Vec<String> = ev.skip_dates.iter().chain(moved.iter()).cloned().collect::<HashSet<_>>().into_iter().collect();
            all.sort();
            ev.skip_dates = all;
        }
    }
    out
}

// ---- Fetching and storing -------------------------------------------------------------

/// `Number(r.event_count) || 0`.
fn event_count(r: &Row) -> i64 {
    let n = db::number(r, "event_count");
    if n.is_nan() { 0 } else { n as i64 }
}

fn row_to_link(r: &Row) -> Value {
    json!({
        "id": r["id"], "name": r["name"], "url": r["url"], "calendarId": db::opt(r, "calendar_id"),
        "lastSyncedAt": db::opt(r, "last_synced_at"), "lastError": db::opt(r, "last_error"),
        "eventCount": event_count(r),
    })
}

/// The addresses to try for a link, best first. webcal:// doesn't say whether
/// it's secure, so it's tried as https:// and then http://.
fn link_candidates(raw: &str) -> Result<Vec<String>, String> {
    let trimmed = raw.trim();
    let lower = trimmed.to_ascii_lowercase();
    let webcal = lower.starts_with("webcal://") || lower.starts_with("webcals://");
    let fixed = if webcal { format!("https://{}", &trimmed[trimmed.find("://").unwrap() + 3..]) } else { trimmed.to_string() };
    let url = url::Url::parse(&fixed).map_err(|_| "That doesn't look like a link. It should start with https:// or webcal://.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("Calendar links start with https:// or webcal://.".into());
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    if host.starts_with("localhost") || host.starts_with("127.") || host.starts_with("0.0.0.0") || host.trim_start_matches('[').starts_with("::1") {
        return Err("That link points at this hub itself.".into());
    }
    let s = url.to_string();
    Ok(if webcal { vec![s.clone(), s.replacen("https:", "http:", 1)] } else { vec![s] })
}

async fn fetch_calendar(hub: &Hub, url: &str) -> Result<(Option<String>, Vec<LinkedEvent>), String> {
    let res = hub.http.get(url).timeout(FETCH_TIMEOUT).header("Accept", "text/calendar, */*").send().await
        .map_err(|_| "Couldn't reach that link. Check it opens in a browser.".to_string())?;
    if !res.status().is_success() {
        return Err(format!("The calendar's website answered {}. Check the link is the subscription (iCal) one.", res.status().as_u16()));
    }
    let text = res.text().await.map_err(|_| "Couldn't reach that link. Check it opens in a browser.".to_string())?;
    if text.encode_utf16().count() > MAX_BYTES {
        return Err("That calendar is too big to subscribe to (over 5 MB).".into());
    }
    if !text.to_ascii_uppercase().contains("BEGIN:VCALENDAR") {
        return Err("That link isn't a calendar. Look for an iCal or \"subscribe\" link.".into());
    }
    let (name, events) = parse_calendar(&text);
    Ok((name, to_linked_events(hub, &events, &home_today(hub))))
}

fn clock(e: &LinkedEvent) -> Option<String> {
    if e.all_day {
        return None;
    }
    let mins = (e.start * 60.0).round() as i64;
    Some(format!("{:02}:{:02}", (mins / 60) % 24, mins % 60))
}

/// Replace a link's events with `events`. Returns how many it now has.
fn store_linked_events(hub: &Hub, household: &str, link_id: &str, calendar_id: Option<&str>, events: &[LinkedEvent]) -> usize {
    let mut db_ = hub.store.db();
    let Ok(tx) = db_.transaction() else { return 0 };
    let mut keep: Vec<String> = Vec::new();
    for e in events {
        let source_id = format!("{link_id}:{}", e.key);
        if keep.contains(&source_id) {
            continue;
        }
        keep.push(source_id.clone());
        let _ = db::run(&tx, "
            INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, member_ids,
              location, repeat_days, repeat_until, skip_dates, source, source_event_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 'ics', ?)
            ON CONFLICT(household_id, source, source_event_id) DO UPDATE SET
              calendar_id = excluded.calendar_id, title = excluded.title, date = excluded.date, end_date = excluded.end_date,
              all_day = excluded.all_day, time = excluded.time, start_hour = excluded.start_hour, end_hour = excluded.end_hour,
              location = excluded.location, repeat_days = excluded.repeat_days, repeat_until = excluded.repeat_until,
              skip_dates = excluded.skip_dates",
            p![
                store::uuid(), household, calendar_id, e.title.clone(), e.date.clone(), e.end_date.clone(), e.all_day, clock(e), e.start, e.end, e.location.clone(),
                e.repeat_days.as_ref().map(|d| d.iter().map(i64::to_string).collect::<Vec<_>>().join(",")), e.repeat_until.clone(), json!(e.skip_dates).to_string(), source_id,
            ]);
    }
    // Whatever the publisher took down comes off the calendar too.
    let existing = db::all(&tx, "SELECT source_event_id FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?", p![household, format!("{link_id}:%")]);
    for row in existing {
        let sid = db::s(&row, "source_event_id");
        if !keep.contains(&sid) {
            let _ = db::run(&tx, "DELETE FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id = ?", p![household, sid]);
        }
    }
    let _ = tx.commit();
    keep.len()
}

/// Re-read one link now. Records the result on the link.
pub async fn sync_link(hub: &Arc<Hub>, link_id: &str) -> Option<Value> {
    let row = db::one(&hub.store.db(), "SELECT * FROM calendar_links WHERE id = ?", p![link_id])?;
    let household = db::s(&row, "household_id");
    match fetch_calendar(hub, &db::s(&row, "url")).await {
        Ok((_, events)) => {
            let count = store_linked_events(hub, &household, link_id, db::text(&row, "calendar_id").as_deref(), &events);
            let _ = db::run(&hub.store.db(), "UPDATE calendar_links SET last_synced_at = ?, last_error = NULL, event_count = ? WHERE id = ?", p![store::now_iso(), count as i64, link_id]);
        }
        Err(message) => {
            let _ = db::run(&hub.store.db(), "UPDATE calendar_links SET last_error = ? WHERE id = ?", p![message, link_id]);
        }
    }
    realtime::broadcast(hub, &household, "events:updated", json!({}));
    db::one(&hub.store.db(), "SELECT * FROM calendar_links WHERE id = ?", p![link_id]).map(|r| row_to_link(&r))
}

/// Re-read every link each hour, starting a minute after the hub comes up.
pub fn start_scheduler(hub: Arc<Hub>) {
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(60)).await;
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        loop {
            tick.tick().await;
            let ids: Vec<String> = db::all(&hub.store.db(), "SELECT id FROM calendar_links", p![]).iter().map(|r| db::s(r, "id")).collect();
            for id in ids {
                sync_link(&hub, &id).await;
            }
        }
    });
}

// ---- /api/v1/calendar-links ------------------------------------------------------------

pub fn router() -> Router<Arc<Hub>> {
    Router::new()
        .route("/", get(list).post(add))
        .route("/{id}", patch(edit).delete(remove))
        .route("/{id}/sync", post(sync))
}

const NOT_MANAGER: &str = "Ask a parent to change calendar links.";

fn own_link(hub: &Hub, household: &str, id: &str) -> Option<Row> {
    db::one(&hub.store.db(), "SELECT * FROM calendar_links WHERE id = ? AND household_id = ?", p![id, household])
}

fn valid_calendar(hub: &Hub, household: &str, calendar_id: Option<&Value>) -> Option<String> {
    let id = calendar_id?.as_str().filter(|s| !s.is_empty())?;
    db::one(&hub.store.db(), "SELECT id FROM calendars WHERE id = ? AND household_id = ?", p![id, household]).map(|_| id.to_string())
}

async fn list(State(hub): State<Arc<Hub>>, user: User) -> Response {
    let rows = db::all(&hub.store.db(), "SELECT * FROM calendar_links WHERE household_id = ? ORDER BY created_at", p![user.household_id.clone()]);
    ok(Value::Array(rows.iter().map(row_to_link).collect()))
}

async fn add(State(hub): State<Arc<Hub>>, user: User, body: Body) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_MANAGER);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let candidates = match link_candidates(body.str("url").unwrap_or("")) {
        Ok(c) => c,
        Err(m) => return error(400, m),
    };
    if candidates.iter().any(|c| db::one(&hub.store.db(), "SELECT 1 FROM calendar_links WHERE household_id = ? AND url = ?", p![household, c]).is_some()) {
        return error(409, "You're already subscribed to that calendar.");
    }
    let mut feed = None;
    let mut url = candidates[0].clone();
    let mut problem = String::new();
    for c in &candidates {
        match fetch_calendar(&hub, c).await {
            Ok(f) => {
                feed = Some(f);
                url = c.clone();
                break;
            }
            Err(m) => {
                if problem.is_empty() {
                    problem = m;
                }
            }
        }
    }
    let Some((feed_name, events)) = feed else { return error(400, problem) };
    let id = store::uuid();
    let host = url::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
    let name = body.text("name").or(feed_name.filter(|n| !n.is_empty())).unwrap_or(host);
    let calendar_id = valid_calendar(&hub, &household, body.raw("calendarId"));
    try_run!(&hub.store.db(), "INSERT INTO calendar_links (id, household_id, url, name, calendar_id) VALUES (?, ?, ?, ?, ?)",
        p![id, household, url, name.chars().take(80).collect::<String>(), calendar_id.clone()]);
    let count = store_linked_events(&hub, &household, &id, calendar_id.as_deref(), &events);
    try_run!(&hub.store.db(), "UPDATE calendar_links SET last_synced_at = ?, event_count = ? WHERE id = ?", p![store::now_iso(), count as i64, id]);
    realtime::broadcast(&hub, &household, "events:updated", json!({}));
    created(own_link(&hub, &household, &id).map(|r| row_to_link(&r)).unwrap_or(Value::Null))
}

async fn edit(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>, body: Body) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_MANAGER);
    }
    let household = user.household_id.clone().unwrap_or_default();
    let Some(row) = own_link(&hub, &household, &id) else { return error(404, "Calendar link not found.") };
    if let Some(name) = body.text("name") {
        try_run!(&hub.store.db(), "UPDATE calendar_links SET name = ? WHERE id = ?", p![name.chars().take(80).collect::<String>(), row["id"].clone()]);
    }
    if body.has("calendarId") {
        let calendar_id = valid_calendar(&hub, &household, body.raw("calendarId"));
        try_run!(&hub.store.db(), "UPDATE calendar_links SET calendar_id = ? WHERE id = ?", p![calendar_id.clone(), row["id"].clone()]);
        try_run!(&hub.store.db(), "UPDATE events SET calendar_id = ? WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?", p![calendar_id, household, format!("{id}:%")]);
        realtime::broadcast(&hub, &household, "events:updated", json!({}));
    }
    ok(own_link(&hub, &household, &id).map(|r| row_to_link(&r)).unwrap_or(Value::Null))
}

async fn sync(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_MANAGER);
    }
    if own_link(&hub, user.household().unwrap_or(""), &id).is_none() {
        return error(404, "Calendar link not found.");
    }
    ok(sync_link(&hub, &id).await.unwrap_or(Value::Null))
}

async fn remove(State(hub): State<Arc<Hub>>, user: User, Path(id): Path<String>) -> Response {
    if !manages(&hub, &user, "calendar") {
        return error(403, NOT_MANAGER);
    }
    let household = user.household_id.clone().unwrap_or_default();
    if own_link(&hub, &household, &id).is_none() {
        return error(404, "Calendar link not found.");
    }
    {
        let mut db_ = hub.store.db();
        if let Ok(tx) = db_.transaction() {
            try_run!(&tx, "DELETE FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?", p![household, format!("{id}:%")]);
            try_run!(&tx, "DELETE FROM calendar_links WHERE id = ?", p![id]);
            let _ = tx.commit();
        };
    }
    realtime::broadcast(&hub, &household, "events:updated", json!({}));
    no_content()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn props_and_text() {
        let p = parse_prop("DTSTART;TZID=\"America/New_York\":20310512T190000").unwrap();
        assert_eq!(p.name, "DTSTART");
        assert_eq!(p.params["TZID"], "America/New_York");
        assert_eq!(p.value, "20310512T190000");
        assert_eq!(unescape_text(" Open house\\, all grades\\nGym "), "Open house, all grades\nGym");
        let (name, events) = parse_calendar("BEGIN:VCALENDAR\r\nX-WR-CALNAME:School\r\nBEGIN:VEVENT\r\nSUMMARY:Long\r\n  title\r\nBEGIN:VALARM\r\nSUMMARY:no\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR");
        assert_eq!(name.as_deref(), Some("School"));
        assert_eq!(events.len(), 1);
        assert_eq!(prop(&events[0], "SUMMARY").unwrap().value, "Long title");
    }

    #[test]
    fn durations() {
        assert_eq!(duration(Some("PT1H30M")), Some(5_400_000));
        assert_eq!(duration(Some("P1D")), Some(86_400_000));
        assert_eq!(duration(Some("P1W2DT3S")), Some((9 * 86_400 + 3) * 1000));
        assert_eq!(duration(Some("1H")), None);
    }

    #[test]
    fn months_overflow_like_date_utc() {
        assert_eq!(utc_date(2031, 1, 31).to_string(), "2031-03-03");
        assert_eq!(utc_date(2031, 12, 1).to_string(), "2032-01-01");
    }

    #[test]
    fn candidates() {
        assert_eq!(link_candidates("webcal://example.com/a.ics").unwrap(), vec!["https://example.com/a.ics", "http://example.com/a.ics"]);
        assert!(link_candidates("http://127.0.0.1/x").is_err());
        assert!(link_candidates("ftp://example.com").is_err());
    }
}
