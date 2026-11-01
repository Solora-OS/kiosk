// ---------------------------------------------------------------------------
// home-time.ts
//
// The household's home time zone, as the hub reports it in the snapshot.
// Event times are home wall-clock times, and chores and countdowns run on the
// home date. A phone somewhere else (a grandparent abroad) uses this to say
// whose time a time is and when it falls for them.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react"
import { formatClock, toISODate } from "./data"

const KEY = "solora.homeTz"

function load(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

let _zone: string | null = load()
const _listeners = new Set<() => void>()

/** Save the zone from the hub's snapshot. */
export function setHomeTimeZone(tz: string | null | undefined): void {
  if (!tz || tz === _zone) return
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
  } catch {
    return
  }
  _zone = tz
  try {
    localStorage.setItem(KEY, tz)
  } catch {
    // Private mode: keep it for this visit only.
  }
  for (const fn of _listeners) fn()
}

export function getHomeTimeZone(): string | null {
  return _zone
}

/** Re-renders when the home zone arrives or changes. */
export function useHomeTimeZone(): string | null {
  return useSyncExternalStore(
    (fn) => {
      _listeners.add(fn)
      return () => _listeners.delete(fn)
    },
    () => _zone,
  )
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
export function homeInstant(iso: string, hour: number, tz: string): number {
  const [y, m, d] = iso.split("-").map(Number)
  const naive = Date.UTC(y, m - 1, d, 0, Math.round(hour * 60))
  // Two passes settle the offset across a DST change.
  const guess = naive - offsetMinutes(tz, naive) * 6e4
  return naive - offsetMinutes(tz, guess) * 6e4
}

/** Whether this phone's clock reads differently from home right now. */
export function inOtherZone(): boolean {
  if (!_zone) return false
  const now = Date.now()
  return offsetMinutes(_zone, now) !== -new Date(now).getTimezoneOffset()
}

/** Today's date at home (yyyy-mm-dd); the phone's own date until the hub has said. */
export function homeTodayISO(): string {
  if (!_zone) return toISODate(new Date())
  return new Intl.DateTimeFormat("en-CA", { timeZone: _zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}

/** "Chicago" for America/Chicago, the place name people know the zone by. */
export function homePlace(): string {
  const tz = _zone ?? ""
  return tz.split("/").pop()?.replace(/_/g, " ") || "home"
}

/**
 * When a home time falls on this phone's clock: "12:15 AM Wed", or "10:15 AM"
 * on the same date. Null when it reads the same here as at home.
 */
export function yourTime(iso: string, hour: number): string | null {
  if (!_zone || !inOtherZone()) return null
  const local = new Date(homeInstant(iso, hour, _zone))
  const localISO = toISODate(local)
  const clock = formatClock(local.getHours() + local.getMinutes() / 60)
  if (localISO === iso && clock === formatClock(hour)) return null
  return localISO === iso ? clock : `${clock} ${local.toLocaleDateString(undefined, { weekday: "short" })}`
}
