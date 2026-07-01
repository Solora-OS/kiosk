-- Lumora local SQLite schema
-- Mirrors the Supabase Postgres schema exactly; all ids are UUIDs stored as TEXT.
-- Run once at server start via migrate.ts — idempotent (CREATE TABLE IF NOT EXISTS).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- households
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS households (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- users  (identity via Supabase Auth — supabase_id links to auth.users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  supabase_id   TEXT UNIQUE,   -- Supabase auth.users.id (uuid)
  password_hash TEXT,          -- kept nullable for legacy rows during migration
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_users_household   ON users(household_id);
CREATE INDEX IF NOT EXISTS idx_users_email       ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_supabase_id ON users(supabase_id);

-- ---------------------------------------------------------------------------
-- members  (household roster — may or may not be linked to a user account)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  initial      TEXT NOT NULL DEFAULT '',
  color        TEXT NOT NULL DEFAULT 'blue',
  role         TEXT NOT NULL DEFAULT 'adult',
  dob          TEXT,
  account      TEXT,       -- display email for linked account
  permissions  TEXT NOT NULL DEFAULT '[]',  -- JSON array of PermissionArea
  pending      INTEGER NOT NULL DEFAULT 0,  -- 1 = outstanding invite
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_members_household ON members(household_id);
CREATE INDEX IF NOT EXISTS idx_members_user      ON members(user_id);

-- ---------------------------------------------------------------------------
-- invites
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id    TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT 'blue',
  dob          TEXT,
  email        TEXT,
  expires_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_invites_household  ON invites(household_id);
CREATE INDEX IF NOT EXISTS idx_invites_token      ON invites(token);
CREATE INDEX IF NOT EXISTS idx_invites_code       ON invites(code);

-- ---------------------------------------------------------------------------
-- calendars
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendars (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT 'blue',
  member_ids   TEXT NOT NULL DEFAULT '[]',  -- JSON array of member ids
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_calendars_household ON calendars(household_id);

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  household_id    TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  calendar_id     TEXT REFERENCES calendars(id) ON DELETE SET NULL,
  title           TEXT NOT NULL,
  date            TEXT NOT NULL,   -- ISO date yyyy-mm-dd
  time            TEXT,            -- HH:MM or empty
  start_hour      REAL NOT NULL DEFAULT 0,
  end_hour        REAL NOT NULL DEFAULT 0,
  member_ids      TEXT NOT NULL DEFAULT '[]',
  location        TEXT,
  source          TEXT,            -- 'google' | 'microsoft' | NULL for manual
  source_event_id TEXT,            -- provider event id for deduplication
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_events_household ON events(household_id);
CREATE INDEX IF NOT EXISTS idx_events_date      ON events(date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(household_id, source, source_event_id)
  ;

-- ---------------------------------------------------------------------------
-- chores
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chores (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  done         INTEGER NOT NULL DEFAULT 0,
  points       INTEGER NOT NULL DEFAULT 0,
  due          TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_chores_household ON chores(household_id);

-- ---------------------------------------------------------------------------
-- lists
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lists (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT 'blue',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_lists_household ON lists(household_id);

-- ---------------------------------------------------------------------------
-- list_items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS list_items (
  id         TEXT PRIMARY KEY,
  list_id    TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  label      TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_list_items_list ON list_items(list_id);

-- ---------------------------------------------------------------------------
-- meals
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meals (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  day          TEXT NOT NULL,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'dinner',
  image        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_meals_household ON meals(household_id);

-- ---------------------------------------------------------------------------
-- notifications  (household-scoped; content shared across all members)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL DEFAULT '',
  time         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_notifications_household ON notifications(household_id);

-- ---------------------------------------------------------------------------
-- notification_states  (per-user read/dismiss state)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notification_states (
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read            INTEGER NOT NULL DEFAULT 0,
  dismissed       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (notification_id, user_id)
);

-- ---------------------------------------------------------------------------
-- photos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id           TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,        -- basename stored under $HOME/.lumora/photos/
  src          TEXT NOT NULL,        -- relative URL served by the API, e.g. /photos/<id>
  caption      TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_photos_household ON photos(household_id);

-- ---------------------------------------------------------------------------
-- kiosk_devices  (devices (tablets/phones) that have paired with this hub)
-- household_id is nullable — devices register before they are claimed by a
-- household, so NOT NULL would break POST /register.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS kiosk_devices (
  id               TEXT PRIMARY KEY,
  household_id     TEXT REFERENCES households(id) ON DELETE CASCADE,
  device_token     TEXT NOT NULL UNIQUE,
  device_name      TEXT NOT NULL DEFAULT 'Lumora Hub',
  pairing_code     TEXT,
  setup_complete   INTEGER NOT NULL DEFAULT 0,
  is_online        INTEGER NOT NULL DEFAULT 0,
  last_heartbeat   TEXT,
  wifi_signal      INTEGER,
  ping_latency_ms  INTEGER,
  battery_percent  REAL,
  device_info      TEXT,
  language         TEXT,
  timezone         TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kiosk_devices_household ON kiosk_devices(household_id);

-- ---------------------------------------------------------------------------
-- calendar_providers  (OAuth tokens for Google / Microsoft calendar import)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_providers (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,   -- 'google' | 'microsoft'
  access_token  TEXT NOT NULL,
  refresh_token TEXT,
  expires_at    INTEGER,         -- Unix timestamp (seconds)
  email         TEXT,            -- provider account email shown in UI
  connected_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(household_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_calendar_providers_household ON calendar_providers(household_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source ON events(household_id, source, source_event_id) ;

-- ---------------------------------------------------------------------------
-- calendar_provider_mappings
-- Maps an external Google calendar or Outlook category → a Lumora calendar.
-- external_id: Google calendarId or Outlook category displayName.
-- calendar_id NULL = events land in the "General" calendar (auto-created).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_provider_mappings (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,   -- 'google' | 'microsoft'
  external_id   TEXT NOT NULL,   -- Google calendarId or Outlook category name
  external_name TEXT NOT NULL,   -- display name shown in UI
  calendar_id   TEXT REFERENCES calendars(id) ON DELETE SET NULL,
  UNIQUE(household_id, provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_cal_mappings_household ON calendar_provider_mappings(household_id);

-- ---------------------------------------------------------------------------
-- activity_logs  (major destructive / invite / update actions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id            TEXT PRIMARY KEY,
  household_id  TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  actor_id      TEXT REFERENCES members(id) ON DELETE SET NULL,
  actor_name    TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,   -- e.g. 'event.delete', 'member.invite', 'meal.create'
  resource_type TEXT NOT NULL,   -- 'event' | 'chore' | 'meal' | 'member' | 'calendar' | 'list'
  resource_id   TEXT,
  resource_name TEXT NOT NULL DEFAULT '',
  metadata      TEXT NOT NULL DEFAULT '{}',  -- JSON blob for extra context
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_household ON activity_logs(household_id);
CREATE INDEX IF NOT EXISTS idx_activity_logs_created   ON activity_logs(created_at);

-- ---------------------------------------------------------------------------
-- calendar_excluded_events
-- Per-event opt-outs set during the import wizard. Events whose IDs appear
-- here are skipped during calendar sync even if the parent calendar is mapped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS calendar_excluded_events (
  id               TEXT PRIMARY KEY,
  household_id     TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,   -- 'google' | 'microsoft'
  external_event_id TEXT NOT NULL,
  UNIQUE(household_id, provider, external_event_id)
);

CREATE INDEX IF NOT EXISTS idx_cal_excluded_household ON calendar_excluded_events(household_id);

-- ---------------------------------------------------------------------------
-- Migration M001: hash device_token at rest (added 2026-06-30)
-- device_token in kiosk_devices previously stored the raw JWT.
-- It now stores SHA-256(jwt) so a DB dump doesn't expose bearer tokens.
-- New rows are written with the hash directly (see routes/kiosk.ts).
-- Run this once against existing databases to backfill the hash:
--
--   UPDATE kiosk_devices
--   SET device_token = lower(hex(sha256(device_token)))
--   WHERE length(device_token) != 64;
--
-- NOTE: SQLite does not have a built-in sha256() function. Use the Node
-- migration script at server/scripts/migrate-token-hashes.ts instead.
-- ---------------------------------------------------------------------------
