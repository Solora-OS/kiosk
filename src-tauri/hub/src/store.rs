//! The hub's files: the SQLite database, the HMAC secret, the hub's identity
//! and its setup code. Same files, same formats as the Node hub
//! (kiosk/server/src/db.ts, lib/hub-identity.ts, lib/setup-code.ts), so a
//! hub moves from Node to Rust by keeping its data directory.

use rand::RngCore;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

const SCHEMA: &str = include_str!("../../../server/scripts/schema.sql");

pub struct Store {
    pub dir: PathBuf,
    db: Mutex<Connection>,
    secret: String,
    identity: HubIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubIdentity {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

impl Store {
    pub fn open(dir: &Path, hub_name: &str) -> anyhow::Result<Store> {
        std::fs::create_dir_all(dir.join("photos"))?;
        set_private(dir);
        let db = Connection::open(dir.join("lumora.db"))?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;
             PRAGMA cache_size = -32000; PRAGMA temp_store = MEMORY; PRAGMA mmap_size = 268435456;",
        )?;
        migrate(&db)?;
        let secret = secret(dir)?;
        let identity = identity(dir, hub_name)?;
        Ok(Store { dir: dir.to_path_buf(), db: Mutex::new(db), secret, identity })
    }

    /// The connection. Calls are short and synchronous, like better-sqlite3's.
    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The HMAC key device tokens are signed with: the secret file's text, as bytes.
    pub fn secret(&self) -> &str {
        &self.secret
    }

    pub fn identity(&self) -> &HubIdentity {
        &self.identity
    }

    pub fn households(&self) -> i64 {
        self.db().query_row("SELECT COUNT(*) FROM households", [], |r| r.get(0)).unwrap_or(0)
    }

    /// This hub's setup code, made and saved the first time it's asked for.
    pub fn setup_code(&self) -> String {
        static CODE: OnceLock<String> = OnceLock::new();
        CODE.get_or_init(|| {
            let path = self.dir.join("setup_code");
            if let Ok(existing) = std::fs::read_to_string(&path) {
                let existing = existing.trim().to_string();
                if !existing.is_empty() {
                    return existing;
                }
            }
            let mut bytes = [0u8; 4];
            rand::thread_rng().fill_bytes(&mut bytes);
            let code = hex::encode_upper(bytes);
            let _ = std::fs::write(&path, &code);
            set_private(&path);
            println!("[setup] Hub setup code: {code}  (shown on the hub's screen until it's set up)");
            code
        })
        .clone()
    }

    /// Whether a typed setup code matches, ignoring case, spaces and dashes.
    pub fn setup_code_matches(&self, input: Option<&str>) -> bool {
        let Some(input) = input else { return false };
        let typed: String = input.to_uppercase().chars().filter(|c| c.is_ascii_hexdigit()).collect();
        !typed.is_empty() && typed == self.setup_code()
    }
}

#[cfg(unix)]
fn set_private(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mode = if path.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}
#[cfg(not(unix))]
fn set_private(_path: &Path) {}

/// Read (or generate) the 64-byte hex secret that signs device tokens.
fn secret(dir: &Path) -> anyhow::Result<String> {
    let path = dir.join(".secret");
    if let Ok(s) = std::fs::read_to_string(&path) {
        return Ok(s.trim().to_string());
    }
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    let s = hex::encode(bytes);
    std::fs::write(&path, &s)?;
    set_private(&path);
    println!("[solora] Generated new HMAC secret at {}", path.display());
    Ok(s)
}

fn identity(dir: &Path, hub_name: &str) -> anyhow::Result<HubIdentity> {
    let path = dir.join("hub-identity.json");
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(id) = serde_json::from_str::<HubIdentity>(&raw) {
            return Ok(id);
        }
    }
    let id = HubIdentity { id: uuid(), name: hub_name.to_string(), created_at: now_iso() };
    std::fs::write(&path, serde_json::to_string_pretty(&id)?)?;
    Ok(id)
}

/// Schema plus the column additions older databases need (db.ts `migrate`).
fn migrate(db: &Connection) -> anyhow::Result<()> {
    db.execute_batch(SCHEMA)?;
    for (table, column, kind) in [
        ("users", "supabase_id", "TEXT"),
        ("users", "account_id", "TEXT"),
    ] {
        add_column(db, table, column, kind);
    }
    db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS users_account_id_key ON users (account_id) WHERE account_id IS NOT NULL")?;
    for (table, column, kind) in [
        ("events", "source", "TEXT"),
        ("events", "source_event_id", "TEXT"),
        ("lists", "position", "INTEGER NOT NULL DEFAULT 0"),
        ("list_items", "position", "INTEGER NOT NULL DEFAULT 0"),
        ("chores", "repeat_days", "TEXT"),
        ("chores", "done_on", "TEXT"),
        ("chores", "icon", "TEXT"),
        ("users", "device_only", "INTEGER NOT NULL DEFAULT 0"),
        ("meals", "date", "TEXT"),
        ("meals", "ingredients", "TEXT NOT NULL DEFAULT '[]'"),
        ("households", "away_from", "TEXT"),
        ("households", "away_until", "TEXT"),
        ("households", "away_label", "TEXT"),
        ("households", "home_layout", "TEXT"),
        ("events", "end_date", "TEXT"),
        ("events", "all_day", "INTEGER NOT NULL DEFAULT 0"),
        ("events", "repeat_days", "TEXT"),
        ("events", "repeat_until", "TEXT"),
        ("events", "skip_dates", "TEXT NOT NULL DEFAULT '[]'"),
        ("events", "countdown", "INTEGER NOT NULL DEFAULT 0"),
        ("list_items", "added_by", "TEXT"),
        ("kiosk_devices", "on_hub", "INTEGER NOT NULL DEFAULT 0"),
        ("kiosk_devices", "display_state", "TEXT"),
        ("kiosk_devices", "display_state_at", "TEXT"),
        ("chores", "keep_while_away", "INTEGER NOT NULL DEFAULT 0"),
        ("events", "remind_minutes", "INTEGER"),
        ("events", "created_by", "TEXT"),
        ("households", "season_settings", "TEXT"),
        ("households", "summer_from", "TEXT"),
        ("households", "summer_until", "TEXT"),
        ("chores", "summer_mode", "TEXT NOT NULL DEFAULT 'same'"),
        ("chores", "summer_days", "TEXT"),
        ("notifications", "ref", "TEXT"),
    ] {
        add_column(db, table, column, kind);
    }
    repair_event_times(db)?;
    Ok(())
}

fn add_column(db: &Connection, table: &str, column: &str, kind: &str) {
    // Fails when the column exists already, which is the point.
    let _ = db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {kind}"));
}

/// db.ts `repairEventTimes`: one-off fixes for events from older versions.
fn repair_event_times(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("UPDATE events SET all_day = 1, start_hour = 0, end_hour = 24 WHERE source IS NOT NULL AND time IS NULL AND all_day = 0")?;
    let rows: Vec<(String, String)> = db
        .prepare("SELECT id, time FROM events WHERE source IS NULL AND all_day = 0 AND start_hour = 0 AND end_hour = 0 AND time IS NOT NULL")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (id, time) in rows {
        let Some((h, m, ampm)) = parse_clock(time.trim()) else { continue };
        let mut hour = h % if ampm.is_some() { 12 } else { 24 };
        if ampm == Some(true) {
            hour += 12;
        }
        let start = hour as f64 + m as f64 / 60.0;
        db.execute("UPDATE events SET start_hour = ?, end_hour = ? WHERE id = ?", rusqlite::params![start, (start + 1.0).min(24.0), id])?;
    }
    Ok(())
}

/// "5:30 PM" → (5, 30, Some(pm)); "17:30" → (17, 30, None).
fn parse_clock(s: &str) -> Option<(u32, u32, Option<bool>)> {
    let (clock, ampm) = match s.rsplit_once(char::is_whitespace) {
        Some((c, p)) if p.eq_ignore_ascii_case("am") => (c.trim(), Some(false)),
        Some((c, p)) if p.eq_ignore_ascii_case("pm") => (c.trim(), Some(true)),
        _ => {
            let lower = s.to_ascii_lowercase();
            if let Some(c) = lower.strip_suffix("am") { (s[..c.len()].trim(), Some(false)) }
            else if let Some(c) = lower.strip_suffix("pm") { (s[..c.len()].trim(), Some(true)) }
            else { (s, None) }
        }
    };
    let (h, m) = clock.split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 || !h.chars().chain(m.chars()).all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some((h.parse().ok()?, m.parse().ok()?, ampm))
}

// ---- Helpers shared by the routes -------------------------------------------

pub fn uuid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// `new Date().toISOString()`: UTC with milliseconds.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// db.ts `parseJson`: a JSON column, or `fallback` when it's null or not JSON.
pub fn parse_json(value: Option<String>, fallback: Value) -> Value {
    value.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(fallback)
}

#[cfg(test)]
mod tests {
    use super::parse_clock;

    #[test]
    fn clocks() {
        assert_eq!(parse_clock("5:30 PM"), Some((5, 30, Some(true))));
        assert_eq!(parse_clock("17:05"), Some((17, 5, None)));
        assert_eq!(parse_clock("9:00am"), Some((9, 0, Some(false))));
        assert_eq!(parse_clock("noon"), None);
    }
}
