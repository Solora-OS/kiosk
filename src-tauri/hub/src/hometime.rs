//! The household's home time zone (lib/home-time.ts). Events are stored as
//! wall-clock hours at home, and chores reset at home midnight.

use crate::db;
use crate::Hub;
use chrono::{Datelike, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;

fn zone(name: &str) -> Option<Tz> {
    name.parse::<Tz>().ok()
}

/// The zone picked on the wall (setup or Settings), else the hub's own clock.
pub fn home_time_zone(hub: &Hub) -> String {
    let picked = db::one(
        &hub.store.db(),
        "SELECT timezone FROM kiosk_devices WHERE timezone IS NOT NULL AND timezone != '' ORDER BY created_at DESC LIMIT 1",
        vec![],
    )
    .and_then(|r| db::text(&r, "timezone"));
    if let Some(tz) = picked.filter(|t| zone(t).is_some()) {
        return tz;
    }
    iana_time_zone::get_timezone().ok().filter(|t| zone(t).is_some()).unwrap_or_else(|| "UTC".into())
}

fn tz(hub: &Hub) -> Tz {
    zone(&home_time_zone(hub)).unwrap_or(Tz::UTC)
}

/// The date at home (yyyy-mm-dd) at `ms`, today by default.
pub fn home_today_at(hub: &Hub, ms: i64) -> String {
    let t = Utc.timestamp_millis_opt(ms).single().unwrap_or_else(Utc::now).with_timezone(&tz(hub));
    format!("{:04}-{:02}-{:02}", t.year(), t.month(), t.day())
}

pub fn home_today(hub: &Hub) -> String {
    home_today_at(hub, Utc::now().timestamp_millis())
}

/// Minutes `tz` is ahead of UTC at instant `ms`.
fn offset_minutes(tz: Tz, ms: i64) -> i64 {
    use chrono::Offset;
    let at = Utc.timestamp_millis_opt(ms - ms.rem_euclid(60_000)).single().unwrap_or_else(Utc::now);
    tz.offset_from_utc_datetime(&at.naive_utc()).fix().local_minus_utc() as i64 / 60
}

/// The instant (ms) a home wall-clock time happens: date + hours since midnight.
pub fn home_instant(hub: &Hub, iso: &str, hour: f64, zone_name: Option<&str>) -> i64 {
    let tz = zone_name.and_then(zone).unwrap_or_else(|| tz(hub));
    let date = NaiveDate::parse_from_str(iso, "%Y-%m-%d").unwrap_or_default();
    let midnight = date.and_hms_opt(0, 0, 0).unwrap().and_utc().timestamp_millis();
    let naive = midnight + (hour * 60.0).round() as i64 * 60_000;
    let guess = naive - offset_minutes(tz, naive) * 60_000;
    naive - offset_minutes(tz, guess) * 60_000
}

/// `iso` moved by `days` calendar days.
pub fn add_days_iso(iso: &str, days: i64) -> String {
    let d = NaiveDate::parse_from_str(iso, "%Y-%m-%d").unwrap_or_default() + chrono::Duration::days(days);
    d.format("%Y-%m-%d").to_string()
}

/// Day of the week (0 = Sunday) of a yyyy-mm-dd date.
pub fn weekday(iso: &str) -> u32 {
    NaiveDate::parse_from_str(iso, "%Y-%m-%d").map(|d| d.weekday().num_days_from_sunday()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn days() {
        assert_eq!(super::add_days_iso("2031-02-28", 1), "2031-03-01");
        assert_eq!(super::add_days_iso("2031-01-01", -1), "2030-12-31");
        assert_eq!(super::weekday("2031-05-12"), 1);
    }
}
