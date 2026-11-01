// ---------------------------------------------------------------------------
// Calendar sync service — Google Calendar API + Microsoft Graph API
//
// Tokens are stored in the calendar_providers table. This service:
//   1. Reads tokens from the DB for each connected provider.
//   2. Refreshes access tokens when expired (using the refresh token).
//   3. Fetches events from the provider APIs for a rolling 90-day window.
//   4. Upserts them into the events table (keyed on source + source_event_id)
//      so repeated syncs are idempotent.
//
// Env vars needed (set in ~/.lumora/.env or systemd unit):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, MICROSOFT_TENANT_ID
// ---------------------------------------------------------------------------

import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { broadcast } from "../broadcaster"
import { encryptToken, decryptToken } from "../lib/token-crypto"

// ----- Config ---------------------------------------------------------------

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || process.env.VITE_GOOGLE_CLIENT_ID || ""
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || process.env.VITE_GOOGLE_CLIENT_SECRET || ""

const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID || process.env.VITE_MICROSOFT_CLIENT_ID || ""
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET || process.env.VITE_MICROSOFT_CLIENT_SECRET || ""
const MICROSOFT_TENANT_ID = process.env.MICROSOFT_TENANT_ID || process.env.VITE_MICROSOFT_TENANT_ID || "common"

// Sync a 90-day window: 7 days in the past, 83 days into the future.
const WINDOW_PAST_DAYS = 7
const WINDOW_FUTURE_DAYS = 83

// ----- Types ----------------------------------------------------------------

type ProviderRow = {
  id: string
  household_id: string
  provider: "google" | "microsoft"
  access_token: string
  refresh_token: string | null
  expires_at: number | null
  email: string | null
}

type NormalisedEvent = {
  source_event_id: string
  title: string
  date: string        // yyyy-mm-dd
  end_date: string | null // yyyy-mm-dd when it ends on a later day
  all_day: number     // 1 for all-day events
  time: string | null // HH:MM or null
  start_hour: number
  end_hour: number
  location: string | null
  calendar_id: string | null  // Lumora calendar id from mapping
}

// ----- Token refresh --------------------------------------------------------

async function refreshGoogle(row: ProviderRow): Promise<string> {
  if (!row.refresh_token) throw new Error("No Google refresh token stored.")
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: decryptToken(row.refresh_token),
    grant_type: "refresh_token",
  })
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`)
  const json = (await res.json()) as { access_token: string; expires_in: number }
  const expiresAt = Math.floor(Date.now() / 1000) + json.expires_in - 60
  getDb()
    .prepare("UPDATE calendar_providers SET access_token=?, expires_at=? WHERE id=?")
    .run(encryptToken(json.access_token), expiresAt, row.id)
  return json.access_token
}

async function refreshMicrosoft(row: ProviderRow): Promise<string> {
  if (!row.refresh_token) throw new Error("No Microsoft refresh token stored.")
  const body = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    refresh_token: decryptToken(row.refresh_token),
    grant_type: "refresh_token",
    scope: "Calendars.Read offline_access",
  })
  const res = await fetch(
    `https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  )
  if (!res.ok) throw new Error(`Microsoft token refresh failed: ${res.status}`)
  const json = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in: number
  }
  const expiresAt = Math.floor(Date.now() / 1000) + json.expires_in - 60
  const encNewRefresh = json.refresh_token ? encryptToken(json.refresh_token) : null
  getDb()
    .prepare(
      "UPDATE calendar_providers SET access_token=?, refresh_token=COALESCE(?,refresh_token), expires_at=? WHERE id=?",
    )
    .run(encryptToken(json.access_token), encNewRefresh, expiresAt, row.id)
  return json.access_token
}

async function getValidToken(row: ProviderRow): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000)
  // Decrypt before returning the token to callers
  if (row.expires_at && row.expires_at > nowSec) return decryptToken(row.access_token)
  return row.provider === "google" ? refreshGoogle(row) : refreshMicrosoft(row)
}

// ----- Google Calendar API --------------------------------------------------

const localISODate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

function isoToDate(iso: string): { date: string; time: string | null; hour: number } {
  // Google sends dateTime (2024-06-01T10:00:00+00:00) or date (2024-06-01).
  if (iso.includes("T")) {
    const d = new Date(iso)
    // Local date, matching the local hour below (toISOString would give the UTC day).
    const date = localISODate(d)
    const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    const hour = d.getHours() + d.getMinutes() / 60
    return { date, time, hour }
  }
  return { date: iso, time: null, hour: 0 }
}

/**
 * Lumora's start/end fields for a provider event. Providers give all-day
 * events an exclusive end date (a one-day event ends the next day), and a timed
 * event that ends exactly at midnight ends at hour 24 of the previous day.
 */
function eventSpan(startIso: string, endIso: string, allDay: boolean) {
  const start = isoToDate(startIso)
  const end = isoToDate(endIso)
  if (allDay) {
    const last = new Date(`${end.date}T00:00:00`)
    last.setDate(last.getDate() - 1)
    const endDate = localISODate(last)
    return { date: start.date, end_date: endDate > start.date ? endDate : null, all_day: 1, time: null, start_hour: 0, end_hour: 24 }
  }
  let endDate = end.date
  let endHour = end.hour
  if (endHour === 0 && endDate > start.date) {
    const prev = new Date(`${endDate}T00:00:00`)
    prev.setDate(prev.getDate() - 1)
    endDate = localISODate(prev)
    endHour = 24
  }
  return {
    date: start.date,
    end_date: endDate > start.date ? endDate : null,
    all_day: 0,
    time: start.time,
    start_hour: start.hour,
    end_hour: endHour,
  }
}

async function fetchGoogleEventsForCalendar(
  token: string,
  googleCalendarId: string,
  lumoraCalendarId: string | null,
): Promise<NormalisedEvent[]> {
  const now = new Date()
  const past = new Date(now)
  past.setDate(past.getDate() - WINDOW_PAST_DAYS)
  const future = new Date(now)
  future.setDate(future.getDate() + WINDOW_FUTURE_DAYS)

  const params = new URLSearchParams({
    timeMin: past.toISOString(),
    timeMax: future.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "500",
  })

  const encodedId = encodeURIComponent(googleCalendarId)
  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodedId}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`Google Calendar fetch failed for ${googleCalendarId}: ${res.status}`)

  const json = (await res.json()) as {
    items: Array<{
      id: string
      summary?: string
      start: { dateTime?: string; date?: string }
      end: { dateTime?: string; date?: string }
      location?: string
      status?: string
    }>
  }

  return (json.items ?? [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const span = eventSpan(e.start.dateTime ?? e.start.date ?? "", e.end.dateTime ?? e.end.date ?? "", !e.start.dateTime)
      return {
        source_event_id: e.id,
        title: e.summary ?? "(No title)",
        ...span,
        location: e.location ?? null,
        calendar_id: lumoraCalendarId,
      }
    })
}

async function fetchGoogleEvents(token: string, householdId: string): Promise<NormalisedEvent[]> {
  // Check for mappings. If none exist, fall back to primary calendar (backwards compat).
  const db = getDb()
  type MappingRow = { external_id: string; calendar_id: string | null }
  const mappings = db
    .prepare("SELECT external_id, calendar_id FROM calendar_provider_mappings WHERE household_id=? AND provider='google'")
    .all(householdId) as MappingRow[]

  if (mappings.length === 0) {
    // No mappings configured — fetch primary only, no calendar assignment.
    return fetchGoogleEventsForCalendar(token, "primary", null)
  }

  const results: NormalisedEvent[] = []
  for (const m of mappings) {
    try {
      const events = await fetchGoogleEventsForCalendar(token, m.external_id, m.calendar_id)
      results.push(...events)
    } catch (err) {
      console.error(`[calendar-sync] Google fetch failed for mapped calendar ${m.external_id}:`, err)
    }
  }
  return results
}

// ----- Microsoft Graph API --------------------------------------------------

async function fetchMicrosoftEvents(token: string, householdId: string): Promise<NormalisedEvent[]> {
  const now = new Date()
  const past = new Date(now)
  past.setDate(past.getDate() - WINDOW_PAST_DAYS)
  const future = new Date(now)
  future.setDate(future.getDate() + WINDOW_FUTURE_DAYS)

  const params = new URLSearchParams({
    startDateTime: past.toISOString(),
    endDateTime: future.toISOString(),
    $select: "id,subject,start,end,isAllDay,location,isCancelled,categories",
    $top: "500",
    $orderby: "start/dateTime",
  })

  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/calendarView?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`Microsoft Graph fetch failed: ${res.status}`)

  const json = (await res.json()) as {
    value: Array<{
      id: string
      subject?: string
      start: { dateTime: string; timeZone: string }
      end: { dateTime: string; timeZone: string }
      location?: { displayName?: string }
      isAllDay?: boolean
      isCancelled?: boolean
      categories?: string[]
    }>
  }

  // Build category → calendar_id lookup from mappings.
  const db = getDb()
  type MappingRow = { external_id: string; calendar_id: string | null }
  const mappings = db
    .prepare("SELECT external_id, calendar_id FROM calendar_provider_mappings WHERE household_id=? AND provider='microsoft'")
    .all(householdId) as MappingRow[]
  const categoryMap = new Map(mappings.map((m) => [m.external_id, m.calendar_id]))

  return (json.value ?? [])
    .filter((e) => !e.isCancelled)
    .map((e) => {
      // Graph returns UTC times without a zone suffix unless asked otherwise.
      const utc = (t: { dateTime: string; timeZone: string }) =>
        t.timeZone === "UTC" && !/[zZ]|[+-]\d\d:\d\d$/.test(t.dateTime) ? `${t.dateTime}Z` : t.dateTime
      const span = e.isAllDay
        ? eventSpan(e.start.dateTime.slice(0, 10), e.end.dateTime.slice(0, 10), true)
        : eventSpan(utc(e.start), utc(e.end), false)
      // Use first matched category mapping, else null (General).
      const calendarId = e.categories?.map((c) => categoryMap.get(c)).find((v) => v !== undefined) ?? null
      return {
        source_event_id: e.id,
        title: e.subject ?? "(No title)",
        ...span,
        location: e.location?.displayName ?? null,
        calendar_id: calendarId ?? null,
      }
    })
}

// ----- Upsert events --------------------------------------------------------

function upsertEvents(
  householdId: string,
  source: "google" | "microsoft",
  events: NormalisedEvent[],
): number {
  const db = getDb()

  // Load excluded event IDs for this provider so wizard opt-outs are respected.
  type ExRow = { external_event_id: string }
  const excluded = new Set(
    (db
      .prepare("SELECT external_event_id FROM calendar_excluded_events WHERE household_id=? AND provider=?")
      .all(householdId, source) as ExRow[]).map((r) => r.external_event_id),
  )

  const validEvents = events.filter(
    (e) => typeof e.source_event_id === "string" && e.source_event_id.trim() !== "" && !excluded.has(e.source_event_id),
  )
  if (validEvents.length !== events.length) {
    console.warn(
      `[calendar-sync] upsertEvents: skipped ${events.length - validEvents.length} event(s) with missing source_event_id`,
    )
  }

  const upsert = db.prepare(`
    INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, location, source, source_event_id)
    VALUES (@id, @household_id, @calendar_id, @title, @date, @end_date, @all_day, @time, @start_hour, @end_hour, @location, @source, @source_event_id)
    ON CONFLICT(household_id, source, source_event_id) DO UPDATE SET
      title       = excluded.title,
      date        = excluded.date,
      end_date    = excluded.end_date,
      all_day     = excluded.all_day,
      time        = excluded.time,
      start_hour  = excluded.start_hour,
      end_hour    = excluded.end_hour,
      location    = excluded.location,
      calendar_id = excluded.calendar_id
  `)

  const run = db.transaction((evts: NormalisedEvent[]) => {
    const valid = evts.filter((e) => e.source_event_id && e.source_event_id.trim() !== "")
    for (const e of valid) {
      upsert.run({
        id: uuidv4(),
        household_id: householdId,
        calendar_id: e.calendar_id ?? null,
        title: e.title,
        date: e.date,
        end_date: e.end_date,
        all_day: e.all_day,
        time: e.time,
        start_hour: e.start_hour,
        end_hour: e.end_hour,
        location: e.location,
        source,
        source_event_id: e.source_event_id,
      })
    }
    return evts.length
  })

  return run(validEvents) as number
}

// ----- Public sync API ------------------------------------------------------

export async function syncHousehold(householdId: string): Promise<void> {
  const db = getDb()
  const providers = db
    .prepare("SELECT * FROM calendar_providers WHERE household_id = ?")
    .all(householdId) as ProviderRow[]

  for (const row of providers) {
    try {
      const token = await getValidToken(row)
      const events =
        row.provider === "google"
          ? await fetchGoogleEvents(token, householdId)
          : await fetchMicrosoftEvents(token, householdId)
      const count = upsertEvents(householdId, row.provider, events)
      console.log(`[calendar-sync] ${row.provider} → ${householdId}: ${count} events upserted`)
      // Notify connected iOS clients so they refresh the calendar view.
      if (count > 0) broadcast(householdId, "events:updated", {} as never)
    } catch (err) {
      console.error(`[calendar-sync] ${row.provider} sync failed for ${householdId}:`, err)
    }
  }
}

export async function syncAllHouseholds(): Promise<void> {
  const db = getDb()
  const rows = db
    .prepare("SELECT DISTINCT household_id FROM calendar_providers")
    .all() as { household_id: string }[]
  await Promise.all(rows.map((r) => syncHousehold(r.household_id)))
}

// ----- Scheduler ------------------------------------------------------------

let _syncInterval: ReturnType<typeof setInterval> | null = null
const SYNC_INTERVAL_MS = 60 * 60 * 1000 // 1 hour

export function startCalendarSyncScheduler(): void {
  if (_syncInterval) return
  // Run once immediately (non-blocking).
  void syncAllHouseholds().catch(() => {})
  _syncInterval = setInterval(() => void syncAllHouseholds().catch(() => {}), SYNC_INTERVAL_MS)
  console.log("[calendar-sync] Scheduler started — syncing every hour.")
}

export function stopCalendarSyncScheduler(): void {
  if (_syncInterval) {
    clearInterval(_syncInterval)
    _syncInterval = null
  }
}
