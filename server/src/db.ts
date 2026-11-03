/**
 * db.ts — better-sqlite3 connection and schema migration.
 *
 * Database file: $HOME/.lumora/lumora.db
 * Schema:        ../scripts/schema.sql  (applied once at startup, idempotent)
 */

import Database from "better-sqlite3"
import fs from "fs"
import os from "os"
import path from "path"

// ---------------------------------------------------------------------------
// Data directory
// ---------------------------------------------------------------------------

export const DATA_DIR = path.join(os.homedir(), ".lumora")
export const DB_PATH = path.join(DATA_DIR, "lumora.db")
export const PHOTOS_DIR = path.join(DATA_DIR, "photos")
export const SECRET_FILE = path.join(DATA_DIR, ".secret")

/** Ensure $HOME/.lumora and its sub-dirs exist. */
export function ensureDataDir(): void {
  for (const dir of [DATA_DIR, PHOTOS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
  }
}

// ---------------------------------------------------------------------------
// HMAC signing secret
// ---------------------------------------------------------------------------

/** Read (or generate) the 64-byte hex HMAC secret used to sign JWTs. */
export function getOrCreateSecret(): string {
  if (fs.existsSync(SECRET_FILE)) {
    return fs.readFileSync(SECRET_FILE, "utf8").trim()
  }
  // Generate a cryptographically random 64-byte secret on first boot.
  const { randomBytes } = require("crypto") as typeof import("crypto")
  const secret = randomBytes(64).toString("hex")
  fs.writeFileSync(SECRET_FILE, secret, { encoding: "utf8", mode: 0o600 })
  console.log("[solora] Generated new HMAC secret at", SECRET_FILE)
  return secret
}

// ---------------------------------------------------------------------------
// Database connection
// ---------------------------------------------------------------------------

let _db: Database.Database | null = null

export function getDb(): Database.Database {
  if (_db) return _db

  ensureDataDir()

  _db = new Database(DB_PATH, {
    // verbose: (msg) => console.log("[sql]", msg),
  })

  // Performance pragmas — WAL + in-memory temp tables + mmap.
  _db.pragma("journal_mode = WAL")
  _db.pragma("foreign_keys = ON")
  _db.pragma("synchronous = NORMAL")
  _db.pragma("cache_size = -32000") // 32 MB
  _db.pragma("temp_store = MEMORY")
  _db.pragma("mmap_size = 268435456") // 256 MB

  migrate(_db)

  return _db
}

// ---------------------------------------------------------------------------
// Schema migration (idempotent CREATE TABLE IF NOT EXISTS)
// ---------------------------------------------------------------------------

function migrate(db: Database.Database): void {
  const schemaPath = path.join(__dirname, "../scripts/schema.sql")
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found: ${schemaPath}`)
  }
  const sql = fs.readFileSync(schemaPath, "utf8")

  // Run the entire schema as one exec — all statements are CREATE TABLE IF NOT
  // EXISTS, CREATE INDEX IF NOT EXISTS, or PRAGMAs, so this is safe to replay.
  db.exec(sql)

  // Idempotent column additions for existing databases that pre-date a schema
  // change. ALTER TABLE ADD COLUMN is only run when the column is missing.
  const addColumnSafe = (table: string, column: string, type: string): void => {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`)
    } catch {
      // Column already exists — ignore.
    }
  }

  addColumnSafe("users",  "supabase_id",      "TEXT") // legacy — superseded by account_id
  addColumnSafe("users",  "account_id",       "TEXT") // Solora central account id
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_account_id_key ON users (account_id) WHERE account_id IS NOT NULL")
  addColumnSafe("events", "source",          "TEXT")
  addColumnSafe("events", "source_event_id", "TEXT")
  addColumnSafe("lists",      "position", "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("list_items", "position", "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("chores", "repeat_days", "TEXT")
  addColumnSafe("chores", "done_on",     "TEXT")
  addColumnSafe("chores", "icon",        "TEXT")
  addColumnSafe("users",  "device_only", "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("meals", "date",        "TEXT")
  addColumnSafe("meals", "ingredients", "TEXT NOT NULL DEFAULT '[]'")
  addColumnSafe("households", "away_from",  "TEXT")
  addColumnSafe("households", "away_until", "TEXT")
  addColumnSafe("households", "away_label", "TEXT")
  addColumnSafe("households", "home_layout", "TEXT")
  addColumnSafe("events", "end_date", "TEXT")
  addColumnSafe("events", "all_day",  "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("events", "repeat_days",  "TEXT")
  addColumnSafe("events", "repeat_until", "TEXT")
  addColumnSafe("events", "skip_dates",   "TEXT NOT NULL DEFAULT '[]'")
  addColumnSafe("events", "countdown",    "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("list_items", "added_by", "TEXT")
  addColumnSafe("kiosk_devices", "on_hub", "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("kiosk_devices", "display_state", "TEXT") // JSON DisplayState the wall last reported
  addColumnSafe("kiosk_devices", "display_state_at", "TEXT")
  addColumnSafe("chores", "keep_while_away", "INTEGER NOT NULL DEFAULT 0")
  addColumnSafe("events", "remind_minutes", "INTEGER")
  addColumnSafe("events", "created_by", "TEXT")
  addColumnSafe("households", "season_settings", "TEXT")
  addColumnSafe("households", "summer_from", "TEXT")
  addColumnSafe("households", "summer_until", "TEXT")
  addColumnSafe("chores", "summer_mode", "TEXT NOT NULL DEFAULT 'same'")
  addColumnSafe("chores", "summer_days", "TEXT")
  addColumnSafe("notifications", "ref", "TEXT")
  repairEventTimes(db)

  console.log("[solora] Database schema applied:", DB_PATH)
}

/**
 * One-off fixes for events written before all-day support and before the
 * events route read the apps' start/end fields. Both are no-ops once applied.
 */
function repairEventTimes(db: Database.Database): void {
  // Imported date-only events were stored as 00:00–00:00 with no time.
  db.exec("UPDATE events SET all_day = 1, start_hour = 0, end_hour = 24 WHERE source IS NOT NULL AND time IS NULL AND all_day = 0")

  // Hand-entered events lost their hours but kept the "5:00 PM" label: recover the start from it.
  type Row = { id: string; time: string }
  const rows = db
    .prepare("SELECT id, time FROM events WHERE source IS NULL AND all_day = 0 AND start_hour = 0 AND end_hour = 0 AND time IS NOT NULL")
    .all() as Row[]
  const fix = db.prepare("UPDATE events SET start_hour = ?, end_hour = ? WHERE id = ?")
  for (const r of rows) {
    const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(r.time.trim())
    if (!m) continue
    let h = Number(m[1]) % (m[3] ? 12 : 24)
    if (m[3]?.toUpperCase() === "PM") h += 12
    const start = h + Number(m[2]) / 60
    fix.run(start, Math.min(start + 1, 24), r.id)
  }
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/** Parse a JSON column that might be a string or already an array/object. */
export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback
  if (typeof value !== "string") return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/** Serialize a value to a JSON string for storage. */
export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** SQLite stores booleans as 0/1 integers. */
export function toBool(value: unknown): boolean {
  return value === 1 || value === true || value === "1"
}
