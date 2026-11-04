//! Event reminders, sent by the hub at the right moment (services/reminders.ts).
//!
//! Every minute the hub looks for event occurrences whose reminder time has just
//! passed and notifies the people in the event (everyone, when it's for the
//! whole family). Times are home wall-clock times, so a reminder for 5:15 PM
//! fires at 5:15 PM at home across daylight-saving changes. reminders_sent keeps
//! a restart or a slow tick from sending one twice.

use crate::db::{self, Row};
use crate::hometime::{add_days_iso, home_instant, home_time_zone, home_today_at, weekday};
use crate::household::{notify_members, Note};
use crate::{p, Hub};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

/// A reminder this late still goes out (a hub restart, a slow tick); older ones are dropped.
const GRACE_MS: i64 = 10 * 60_000;
/// All-day events are reminded about relative to 9 AM.
const ALL_DAY_HOUR: f64 = 9.0;

/// Whether an occurrence of `e` starts on `iso` (the apps' occurrencesOn, for start days).
fn starts_on(e: &Row, iso: &str) -> bool {
    let date = db::s(e, "date");
    let Some(days) = db::text(e, "repeat_days").filter(|d| !d.is_empty()) else { return date == iso };
    if iso < date.as_str() || db::text(e, "repeat_until").filter(|u| !u.is_empty()).is_some_and(|u| iso > u.as_str()) {
        return false;
    }
    let day = weekday(iso) as f64;
    // "".split(",").map(Number) → [0]; Number(" 2") → 2
    if !days.split(',').any(|d| d.trim().parse::<f64>().unwrap_or(if d.trim().is_empty() { 0.0 } else { f64::NAN }) == day) {
        return false;
    }
    !db::json_col(e, "skip_dates", json!([])).as_array().into_iter().flatten().any(|s| s.as_str() == Some(iso))
}

fn clock(hour: f64) -> String {
    let mins = (hour * 60.0).round() as i64;
    let h = (mins / 60) % 24;
    format!("{}:{:02} {}", if h % 12 == 0 { 12 } else { h % 12 }, mins % 60, if h < 12 { "AM" } else { "PM" })
}

/// A JS number as `${n}` prints it (for the whole and simple values reminders use).
fn js(n: f64) -> String {
    if n.fract() == 0.0 { format!("{}", n as i64) } else { format!("{n}") }
}

/// "In 30 minutes", "Starting now", "Tomorrow", "In 2 hours".
fn lead(minutes: f64, all_day: bool) -> String {
    if all_day {
        return if minutes >= 1440.0 {
            if minutes == 1440.0 { "Tomorrow".into() } else { format!("In {} days", js((minutes / 1440.0).round())) }
        } else {
            "Today".into()
        };
    }
    if minutes == 0.0 {
        return "Starting now".into();
    }
    if minutes < 60.0 {
        return format!("In {} minutes", js(minutes));
    }
    if minutes % 1440.0 == 0.0 {
        return if minutes == 1440.0 { "Tomorrow".into() } else { format!("In {} days", js(minutes / 1440.0)) };
    }
    let hours = minutes / 60.0;
    let n = if hours.fract() == 0.0 { js(hours) } else { format!("{hours:.1}") };
    format!("In {n} {}", if hours == 1.0 { "hour" } else { "hours" })
}

/// Send every reminder that came due in the last few minutes. Returns how many people were notified.
pub fn run_reminders(hub: &Arc<Hub>, now: i64) -> usize {
    let events = db::all(&hub.store.db(), "SELECT * FROM events WHERE remind_minutes IS NOT NULL", p![]);
    if events.is_empty() {
        return 0;
    }
    let tz = home_time_zone(hub);
    let today = home_today_at(hub, now);
    let mut sent = 0;

    for e in &events {
        let remind = db::number(e, "remind_minutes");
        if !remind.is_finite() {
            continue;
        }
        // A reminder up to a week ahead can belong to an occurrence up to eight days out.
        let span = (remind / 1440.0).ceil() as i64 + 1;
        let all_day = db::number(e, "all_day") != 0.0;
        let start_hour = db::number(e, "start_hour");
        let (id, household) = (db::s(e, "id"), db::s(e, "household_id"));
        for k in -1..=span {
            let day = add_days_iso(&today, k);
            if !starts_on(e, &day) {
                continue;
            }
            let start = home_instant(hub, &day, if all_day { ALL_DAY_HOUR } else { start_hour }, Some(&tz));
            let fire = start - (remind * 60_000.0) as i64;
            if fire > now || fire <= now - GRACE_MS {
                continue;
            }

            let recipients: Vec<String> = {
                let db_ = hub.store.db();
                let members: Vec<String> = db::all(&db_, "SELECT id FROM members WHERE household_id = ?", p![household]).iter().map(|m| db::s(m, "id")).collect();
                let listed: Vec<String> = db::json_col(e, "member_ids", json!([])).as_array().into_iter().flatten()
                    .filter_map(Value::as_str).filter(|id| members.iter().any(|m| m == id)).map(str::to_string).collect();
                (if listed.is_empty() { members } else { listed }).into_iter()
                    .filter(|m| db::run(&db_, "INSERT OR IGNORE INTO reminders_sent (event_id, occurrence_date, member_id) VALUES (?, ?, ?)", p![id, day, m]).unwrap_or(0) > 0)
                    .collect()
            };
            if recipients.is_empty() {
                continue;
            }

            let when = if all_day { lead(remind, true) } else { format!("{} · {}", lead(remind, false), clock(start_hour)) };
            let body = match db::text(e, "location").filter(|l| !l.is_empty()) {
                Some(loc) => format!("{when} · {loc}"),
                None => when,
            };
            let time = if all_day { "All day".to_string() } else { clock(start_hour) };
            let reference = format!("reminder:{id}:{day}");
            sent += recipients.len();
            notify_members(hub, &household, Some(recipients), Note { title: &db::s(e, "title"), body: &body, time: &time, reference: Some(&reference) });
        }
    }
    sent
}

/// Check for due reminders every minute, starting now.
pub fn start_scheduler(hub: Arc<Hub>) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            run_reminders(&hub, chrono::Utc::now().timestamp_millis());
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wording() {
        assert_eq!(clock(17.25), "5:15 PM");
        assert_eq!(clock(0.0), "12:00 AM");
        assert_eq!(lead(0.0, false), "Starting now");
        assert_eq!(lead(30.0, false), "In 30 minutes");
        assert_eq!(lead(60.0, false), "In 1 hour");
        assert_eq!(lead(90.0, false), "In 1.5 hours");
        assert_eq!(lead(1440.0, false), "Tomorrow");
        assert_eq!(lead(2880.0, false), "In 2 days");
        assert_eq!(lead(0.0, true), "Today");
        assert_eq!(lead(4320.0, true), "In 3 days");
    }
}
