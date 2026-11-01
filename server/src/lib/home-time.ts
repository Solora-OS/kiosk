/**
 * home-time.ts — the household's home time zone.
 *
 * Events are stored as wall-clock hours in home time, and chores reset at home
 * midnight. Phones elsewhere (a grandparent abroad) get this zone in the
 * snapshot so they can say whose time a time is and convert it to their own.
 */

import { getDb } from "../db"

function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** The zone picked on the wall (setup or Settings), else the hub's own clock. */
export function homeTimeZone(): string {
  const row = getDb()
    .prepare("SELECT timezone FROM kiosk_devices WHERE timezone IS NOT NULL AND timezone != '' ORDER BY created_at DESC LIMIT 1")
    .get() as { timezone?: string } | undefined
  if (validZone(row?.timezone)) return row.timezone
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
}

/** The date at home (yyyy-mm-dd) at instant `ms`, today by default. */
export function homeToday(ms = Date.now()): string {
  // en-CA formats as yyyy-mm-dd.
  return new Intl.DateTimeFormat("en-CA", { timeZone: homeTimeZone(), year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms))
}

/** Minutes `tz` is ahead of UTC at instant `ms`. */
function offsetMinutes(tz: string, ms: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(ms)).map((p) => [p.type, Number(p.value)]),
  )
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  return Math.round((asUtc - Math.floor(ms / 6e4) * 6e4) / 6e4)
}

/** The instant a home wall-clock time (date + hours since midnight) happens. */
export function homeInstant(iso: string, hour: number, tz = homeTimeZone()): number {
  const [y, m, d] = iso.split("-").map(Number)
  const naive = Date.UTC(y, m - 1, d, 0, Math.round(hour * 60))
  // Two passes settle the offset across a daylight-saving change.
  const guess = naive - offsetMinutes(tz, naive) * 6e4
  return naive - offsetMinutes(tz, guess) * 6e4
}

/** `iso` moved by `days` calendar days. */
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
