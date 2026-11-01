/**
 * calendar-links.ts — calendars the family subscribes to by link: a school
 * district's holidays, a sports league, a café's shift schedule.
 *
 * The hub fetches each iCal link (https:// or webcal://), reads its events,
 * and keeps them in the events table with source "ics", re-reading every hour.
 * Events the publisher removes disappear here too. Times arrive in the feed's
 * zone (UTC, a TZID, or floating) and are stored as home wall-clock times like
 * every other event.
 *
 * Weekly and daily repeats become Solora repeats (with skipped dates); other
 * repeats (monthly, yearly, every other week) are written out as single events
 * for the next year.
 */

import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { broadcast } from "../broadcaster"
import { addDaysISO, homeInstant, homeTimeZone, homeToday } from "../lib/home-time"

const FETCH_TIMEOUT_MS = 15_000
const MAX_BYTES = 5 * 1024 * 1024
/** Past events older than this aren't imported; future ones up to a year and a bit. */
const KEEP_PAST_DAYS = 30
const EXPAND_DAYS = 400
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

// ----- Reading iCal ---------------------------------------------------------

type Prop = { name: string; params: Record<string, string>; value: string }
type VEvent = Prop[]

/** Unfold continuation lines and split into properties. */
function lines(text: string): string[] {
  return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/)
}

function parseProp(line: string): Prop | null {
  // The value starts at the first colon outside a quoted parameter.
  let quoted = false
  let at = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\"") quoted = !quoted
    else if (line[i] === ":" && !quoted) { at = i; break }
  }
  if (at < 0) return null
  const [name, ...rawParams] = line.slice(0, at).split(";")
  const params: Record<string, string> = {}
  for (const p of rawParams) {
    const eq = p.indexOf("=")
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "")
  }
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) }
}

const unescapeText = (s: string) => s.replace(/\\n/gi, "\n").replace(/\\([,;\\])/g, "$1").trim()

export function parseCalendar(text: string): { name: string | null; events: VEvent[] } {
  let name: string | null = null
  const events: VEvent[] = []
  let current: VEvent | null = null
  let depth = 0 // nested blocks (VALARM) inside an event
  for (const line of lines(text)) {
    if (!line) continue
    const p = parseProp(line)
    if (!p) continue
    if (p.name === "BEGIN") {
      if (p.value.toUpperCase() === "VEVENT") { current = []; depth = 0 } else if (current) depth++
      continue
    }
    if (p.name === "END") {
      if (p.value.toUpperCase() === "VEVENT" && current) { events.push(current); current = null } else if (current) depth--
      continue
    }
    if (current && depth === 0) current.push(p)
    else if (!current && p.name === "X-WR-CALNAME") name = unescapeText(p.value)
  }
  return { name, events }
}

const get = (e: VEvent, name: string) => e.find((p) => p.name === name)
const getAll = (e: VEvent, name: string) => e.filter((p) => p.name === name)

function validZone(tz: string | undefined): tz is string {
  if (!tz) return false
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true } catch { return false }
}

/** Home wall-clock date and hour for an instant. */
function homeWall(ms: number, tz: string): { date: string; hour: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric",
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  )
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) + Number(parts.minute) / 60 }
}

type When = { allDay: true; date: string } | { allDay: false; ms: number }

/** A DTSTART/DTEND/EXDATE/RECURRENCE-ID value: a whole day, or an instant. */
function readWhen(p: Prop | undefined, value = p?.value, home = homeTimeZone()): When | null {
  if (!p || !value) return null
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/)
  if (!m) return null
  const date = `${m[1]}-${m[2]}-${m[3]}`
  if (!m[4] || p.params.VALUE === "DATE") return { allDay: true, date }
  const hour = Number(m[4]) + Number(m[5]) / 60 + Number(m[6] ?? 0) / 3600
  if (m[7]) return { allDay: false, ms: Date.UTC(+m[1], +m[2] - 1, +m[3]) + hour * 3600e3 }
  // A named zone, or floating time, which means "wherever you are": home.
  return { allDay: false, ms: homeInstant(date, hour, validZone(p.params.TZID) ? p.params.TZID : home) }
}

/** "PT1H30M", "P1D" → milliseconds. */
function duration(v: string | undefined): number | null {
  const m = v?.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  return ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 24 * 3600 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000
}

export type LinkedEvent = {
  key: string; title: string; location: string | null
  date: string; endDate: string | null; allDay: boolean; start: number; end: number
  repeatDays: number[] | null; repeatUntil: string | null; skipDates: string[]
}

/** Turn a feed's events into Solora events, in home time. */
/**
 * An event as the feed describes it, in its own zone: the local date and time
 * it starts on, so repeats can be worked out the way the publisher meant them
 * ("Tuesdays at 5:30 PM in New York") before each is turned into home time.
 */
type Template = {
  title: string; location: string | null; allDay: boolean
  localDate: string; localHour: number; tz: string; durationMs: number; spanDays: number
}

function template(e: VEvent, home: string): Template | null {
  const startProp = get(e, "DTSTART")
  const start = readWhen(startProp)
  if (!startProp || !start) return null
  const title = unescapeText(get(e, "SUMMARY")?.value ?? "") || "(No title)"
  const location = get(e, "LOCATION") ? unescapeText(get(e, "LOCATION")!.value) || null : null
  const endProp = readWhen(get(e, "DTEND"))
  if (start.allDay) {
    // DTEND is exclusive for whole days.
    const last = endProp?.allDay ? addDaysISO(endProp.date, -1) : start.date
    const spanDays = last > start.date ? Math.round((Date.parse(last) - Date.parse(start.date)) / 864e5) : 0
    return { title, location, allDay: true, localDate: start.date, localHour: 0, tz: home, durationMs: 0, spanDays }
  }
  const tz = /Z$/.test(startProp.value) ? "UTC" : validZone(startProp.params.TZID) ? startProp.params.TZID : home
  const local = homeWall(start.ms, tz)
  const endMs = endProp && !endProp.allDay ? endProp.ms : start.ms + (duration(get(e, "DURATION")?.value) ?? 3600e3)
  return { title, location, allDay: false, localDate: local.date, localHour: local.hour, tz, durationMs: Math.max(0, endMs - start.ms), spanDays: 0 }
}

type Occurrence = Pick<LinkedEvent, "title" | "location" | "date" | "endDate" | "allDay" | "start" | "end">

/** The occurrence that starts on the feed's local date `localDay`, in home time. */
function occurrence(t: Template, localDay: string, home: string): Occurrence {
  if (t.allDay) {
    return { title: t.title, location: t.location, date: localDay, endDate: t.spanDays ? addDaysISO(localDay, t.spanDays) : null, allDay: true, start: 0, end: 24 }
  }
  const startMs = homeInstant(localDay, t.localHour, t.tz)
  const s = homeWall(startMs, home)
  let f = homeWall(startMs + t.durationMs, home)
  // Ending at midnight means the end of the day before, not the start of the next.
  if (f.hour === 0 && f.date > s.date) f = { date: addDaysISO(f.date, -1), hour: 24 }
  return { title: t.title, location: t.location, date: s.date, endDate: f.date > s.date ? f.date : null, allDay: false, start: s.hour, end: f.hour }
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5)
const weekdayOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay()

/** Turn a feed's events into Solora events, in home time. */
export function toLinkedEvents(vevents: VEvent[], today = homeToday()): LinkedEvent[] {
  const home = homeTimeZone()
  const from = addDaysISO(today, -KEEP_PAST_DAYS)
  const to = addDaysISO(today, EXPAND_DAYS)
  const out: LinkedEvent[] = []
  // Moved or cancelled single occurrences of a series, by series UID (as home dates).
  const overrides = new Map<string, string[]>()
  const dayOf = (w: When) => (w.allDay ? w.date : homeWall(w.ms, home).date)
  const single = (o: Occurrence, key: string): LinkedEvent => ({ ...o, key, repeatDays: null, repeatUntil: null, skipDates: [] })

  for (const e of vevents) {
    const uid = get(e, "UID")?.value ?? ""
    const recur = get(e, "RECURRENCE-ID")
    const cancelled = get(e, "STATUS")?.value.toUpperCase() === "CANCELLED"
    const t = template(e, home)
    if (recur && uid) {
      const original = readWhen(recur)
      if (original) overrides.set(uid, [...(overrides.get(uid) ?? []), dayOf(original)])
      if (cancelled || !t) continue
      const o = occurrence(t, t.localDate, home)
      if (o.date >= from && o.date <= to) out.push(single(o, `${uid}@${original ? dayOf(original) : o.date}`))
      continue
    }
    if (cancelled || !t) continue
    const first = occurrence(t, t.localDate, home)
    const key = uid || `${t.title}@${first.date}`
    const skips = getAll(e, "EXDATE").flatMap((p) => p.value.split(",").map((v) => readWhen(p, v)).filter((w): w is When => !!w).map(dayOf))

    const rule = Object.fromEntries((get(e, "RRULE")?.value ?? "").split(";").filter(Boolean).map((kv) => kv.split("=") as [string, string]))
    if (!rule.FREQ) {
      if ((first.endDate ?? first.date) >= from && first.date <= to) out.push(single(first, key))
      continue
    }
    const interval = Number(rule.INTERVAL ?? 1)
    const untilWhen = rule.UNTIL ? readWhen({ name: "UNTIL", params: rule.UNTIL.length === 8 ? { VALUE: "DATE" } : {}, value: rule.UNTIL }) : null
    // UNTIL in the feed's own calendar, so it lines up with local occurrence dates.
    const localUntil = untilWhen ? (untilWhen.allDay ? untilWhen.date : homeWall(untilWhen.ms, t.tz).date) : null
    const byDay = (rule.BYDAY ?? "").split(",").map((d) => DAYS.indexOf(d.replace(/^[+-]?\d+/, ""))).filter((d) => d >= 0)

    if ((rule.FREQ === "WEEKLY" || rule.FREQ === "DAILY") && interval === 1) {
      const localDays = rule.FREQ === "DAILY" ? [0, 1, 2, 3, 4, 5, 6] : byDay.length ? byDay : [weekdayOf(t.localDate)]
      // When home is ahead or behind enough to change the date, the weekdays move with it.
      const shift = daysBetween(t.localDate, first.date)
      const homeDays = [...new Set(localDays.map((d) => (((d + shift) % 7) + 7) % 7))].sort()
      let until = localUntil ? addDaysISO(localUntil, shift) : null
      if (rule.COUNT && !until) until = addDaysISO(first.date, Math.ceil(Number(rule.COUNT) / localDays.length) * 7 - 1)
      if (until && until < from) continue
      out.push({ ...first, key, repeatDays: homeDays, repeatUntil: until, skipDates: skips })
      continue
    }

    // Anything else is worked out in the feed's calendar and written out as single events.
    const count = rule.COUNT ? Number(rule.COUNT) : Infinity
    const localTo = addDaysISO(to, 2)
    const emit = (localDay: string) => {
      const o = occurrence(t, localDay, home)
      if (o.date >= from && o.date <= to && !skips.includes(o.date)) out.push(single(o, `${key}#${o.date}`))
    }
    let made = 0
    // "First Monday of the month" (BYDAY=1MO), "last Friday" (BYDAY=-1FR).
    const nth = rule.FREQ === "MONTHLY" ? (rule.BYDAY ?? "").match(/^([+-]?\d)([A-Z]{2})$/) : null
    if (nth) {
      const n = Number(nth[1]), weekday = DAYS.indexOf(nth[2])
      const [y0, m0] = t.localDate.split("-").map(Number)
      for (let k = 0; made < count && k < 240; k += interval) {
        const firstOfMonth = new Date(Date.UTC(y0, m0 - 1 + k, 1))
        const y = firstOfMonth.getUTCFullYear(), mo = firstOfMonth.getUTCMonth()
        const lastDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
        const dom = n > 0
          ? 1 + ((weekday - firstOfMonth.getUTCDay() + 7) % 7) + (n - 1) * 7
          : lastDay - ((new Date(Date.UTC(y, mo, lastDay)).getUTCDay() - weekday + 7) % 7) + (n + 1) * 7
        if (dom < 1 || dom > lastDay) continue
        const day = `${y}-${String(mo + 1).padStart(2, "0")}-${String(dom).padStart(2, "0")}`
        if (day < t.localDate) continue
        if (day > localTo || (localUntil && day > localUntil)) break
        made++
        emit(day)
      }
      continue
    }
    for (let n = 0, day = t.localDate; made < count && n < 1000 && day <= localTo && (!localUntil || day <= localUntil); n++) {
      emit(day)
      made++
      const [y, mo, d] = day.split("-").map(Number)
      day = rule.FREQ === "YEARLY" ? `${y + interval}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`
        : rule.FREQ === "MONTHLY" ? new Date(Date.UTC(y, mo - 1 + interval, d)).toISOString().slice(0, 10)
        : addDaysISO(day, (rule.FREQ === "WEEKLY" ? 7 : 1) * interval)
    }
  }

  // A moved or cancelled occurrence comes off its series.
  for (const ev of out) {
    const moved = overrides.get(ev.key)
    if (moved && ev.repeatDays) ev.skipDates = [...new Set([...ev.skipDates, ...moved])].sort()
  }
  return out
}

// ----- Fetching and storing ---------------------------------------------------

export type CalendarLink = {
  id: string; name: string; url: string; calendarId: string | null
  lastSyncedAt: string | null; lastError: string | null; eventCount: number
}

export function rowToLink(r: Record<string, unknown>): CalendarLink {
  return {
    id: r.id as string, name: r.name as string, url: r.url as string,
    calendarId: (r.calendar_id as string) ?? null, lastSyncedAt: (r.last_synced_at as string) ?? null,
    lastError: (r.last_error as string) ?? null, eventCount: Number(r.event_count) || 0,
  }
}

/**
 * The web addresses to try for a link, best first. A webcal:// link doesn't
 * say whether it's secure, so it's tried as https:// and then http://.
 */
export function linkCandidates(raw: string): string[] {
  const trimmed = raw.trim()
  const webcal = /^webcals?:\/\//i.test(trimmed)
  let url: URL
  try { url = new URL(trimmed.replace(/^webcals?:\/\//i, "https://")) } catch { throw new Error("That doesn't look like a link. It should start with https:// or webcal://.") }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Calendar links start with https:// or webcal://.")
  if (/^(localhost|127\.|0\.0\.0\.0|\[?::1\]?)/i.test(url.hostname)) throw new Error("That link points at this hub itself.")
  return webcal ? [url.toString(), url.toString().replace(/^https:/, "http:")] : [url.toString()]
}

export async function fetchCalendar(url: string): Promise<{ name: string | null; events: LinkedEvent[] }> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "text/calendar, */*" } })
  } catch {
    throw new Error("Couldn't reach that link. Check it opens in a browser.")
  }
  if (!res.ok) throw new Error(`The calendar's website answered ${res.status}. Check the link is the subscription (iCal) one.`)
  const text = await res.text()
  if (text.length > MAX_BYTES) throw new Error("That calendar is too big to subscribe to (over 5 MB).")
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link isn't a calendar. Look for an iCal or \"subscribe\" link.")
  const parsed = parseCalendar(text)
  return { name: parsed.name, events: toLinkedEvents(parsed.events) }
}

const clockColumn = (e: LinkedEvent) => {
  if (e.allDay) return null
  const mins = Math.round(e.start * 60)
  return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`
}

/** Replace a link's events with `events`. Returns how many it now has. */
export function storeLinkedEvents(householdId: string, linkId: string, calendarId: string | null, events: LinkedEvent[]): number {
  const db = getDb()
  const upsert = db.prepare(`
    INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, member_ids,
      location, repeat_days, repeat_until, skip_dates, source, source_event_id)
    VALUES (@id, @household, @calendar, @title, @date, @endDate, @allDay, @time, @start, @end, '[]',
      @location, @repeatDays, @repeatUntil, @skipDates, 'ics', @sourceId)
    ON CONFLICT(household_id, source, source_event_id) DO UPDATE SET
      calendar_id = excluded.calendar_id, title = excluded.title, date = excluded.date, end_date = excluded.end_date,
      all_day = excluded.all_day, time = excluded.time, start_hour = excluded.start_hour, end_hour = excluded.end_hour,
      location = excluded.location, repeat_days = excluded.repeat_days, repeat_until = excluded.repeat_until,
      skip_dates = excluded.skip_dates
  `)
  const run = db.transaction(() => {
    const keep = new Set<string>()
    for (const e of events) {
      const sourceId = `${linkId}:${e.key}`
      if (keep.has(sourceId)) continue
      keep.add(sourceId)
      upsert.run({
        id: uuidv4(), household: householdId, calendar: calendarId, title: e.title, date: e.date, endDate: e.endDate,
        allDay: e.allDay ? 1 : 0, time: clockColumn(e), start: e.start, end: e.end, location: e.location,
        repeatDays: e.repeatDays ? e.repeatDays.join(",") : null, repeatUntil: e.repeatUntil, skipDates: JSON.stringify(e.skipDates), sourceId,
      })
    }
    // Whatever the publisher took down comes off the calendar too.
    const existing = db.prepare("SELECT source_event_id FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?")
      .all(householdId, `${linkId}:%`) as { source_event_id: string }[]
    const drop = db.prepare("DELETE FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id = ?")
    for (const row of existing) if (!keep.has(row.source_event_id)) drop.run(householdId, row.source_event_id)
    return keep.size
  })
  return run()
}

/** Re-read one link now. Records the result on the link; throws only for a missing link. */
export async function syncLink(linkId: string): Promise<CalendarLink> {
  const db = getDb()
  const row = db.prepare("SELECT * FROM calendar_links WHERE id = ?").get(linkId) as Record<string, unknown> | undefined
  if (!row) throw new Error("Calendar link not found.")
  const householdId = row.household_id as string
  try {
    const feed = await fetchCalendar(row.url as string)
    const count = storeLinkedEvents(householdId, linkId, (row.calendar_id as string) ?? null, feed.events)
    db.prepare("UPDATE calendar_links SET last_synced_at = ?, last_error = NULL, event_count = ? WHERE id = ?")
      .run(new Date().toISOString(), count, linkId)
  } catch (err) {
    db.prepare("UPDATE calendar_links SET last_error = ? WHERE id = ?").run((err as Error).message, linkId)
  }
  broadcast(householdId, "events:updated", {} as never)
  return rowToLink(db.prepare("SELECT * FROM calendar_links WHERE id = ?").get(linkId) as Record<string, unknown>)
}

export async function syncAllLinks(): Promise<void> {
  const ids = (getDb().prepare("SELECT id FROM calendar_links").all() as { id: string }[]).map((r) => r.id)
  for (const id of ids) await syncLink(id).catch(() => {})
}

let timer: ReturnType<typeof setInterval> | null = null

/** Re-read every link each hour, starting a minute after the hub comes up. */
export function startCalendarLinkScheduler(): void {
  if (timer) return
  setTimeout(() => void syncAllLinks(), 60_000)
  timer = setInterval(() => void syncAllLinks(), 60 * 60_000)
}
