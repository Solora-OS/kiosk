import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, parseJson, toBool } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { logActivity, writeLog } from "./activity-logs"
import { callerMember, manages } from "../lib/household-member"
import type { CalendarEvent } from "../types"

const router = Router()
router.use(requireAuth)

export function rowToEvent(r: Record<string, unknown>): CalendarEvent {
  const start = Number(r.start_hour) || 0
  const end = Number(r.end_hour) || 0
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    calendarId: (r.calendar_id as string) ?? undefined,
    title: r.title as string,
    date: r.date as string,
    endDate: (r.end_date as string) ?? undefined,
    allDay: toBool(r.all_day),
    repeatDays: parseRepeatDays(r.repeat_days),
    repeatUntil: (r.repeat_until as string) ?? undefined,
    skipDates: parseJson<string[]>(r.skip_dates, []),
    countdown: toBool(r.countdown),
    time: (r.time as string) ?? undefined,
    start,
    end,
    startHour: start,
    endHour: end,
    memberIds: parseJson<string[]>(r.member_ids, []),
    location: (r.location as string) ?? undefined,
    createdAt: r.created_at as string,
    source: (r.source as string) ?? undefined,
    reminderMinutes: r.remind_minutes == null ? null : Number(r.remind_minutes),
    createdBy: (r.created_by as string) ?? null,
  }
}

const NOT_YOURS = "Only whoever added this event, or a parent, can change it."

/**
 * Who may change an existing event: anyone who manages the calendar, and the
 * member who added it. Everyone else can add events of their own.
 */
function mayChangeEvent(user: AuthRequest["user"], row: Record<string, unknown>): boolean {
  if (manages(user, "calendar")) return true
  const me = callerMember(user)
  return !!me && !!row.created_by && row.created_by === me.id
}

/** Minutes before the start to remind (all-day events count from 9 AM); null for no reminder. */
function reminderColumn(value: unknown): number | null {
  const n = Number(value)
  return value === null || value === undefined || value === "" || !Number.isInteger(n) || n < 0 || n > 10080 ? null : n
}

function parseRepeatDays(value: unknown): number[] | undefined {
  if (typeof value !== "string" || !value) return undefined
  const days = value.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  return days.length ? days : undefined
}

/** Normalise a repeatDays body field to its column value ("2,4" or null). */
function repeatDaysColumn(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const days = [...new Set(value.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort()
  return days.length ? days.join(",") : null
}

/** Normalise skipDates to a sorted JSON array of yyyy-mm-dd strings. */
function skipDatesColumn(value: unknown): string {
  return JSON.stringify(Array.isArray(value) ? [...new Set(value.filter(isISODate))].sort() : [])
}

type TimeFields = { date: string; endDate: string | null; allDay: boolean; start: number; end: number }

const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
/** Hours since midnight, clamped to the day and rounded to the minute. */
const toHour = (v: unknown, fallback: number): number => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(24, Math.max(0, Math.round(n * 60) / 60)) : fallback
}
const pick = (body: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const k of keys) if (k in body) return body[k]
  return undefined
}
const has = (body: Record<string, unknown>, ...keys: string[]) => keys.some((k) => k in body)

/**
 * Merge the time fields in a request body over `base` and make them consistent:
 * all-day events span the whole day, an end date on or before the start date is
 * dropped, and a same-day event always ends after it starts. The phone sends
 * camelCase start/end, the kiosk sends snake_case, older builds startHour.
 */
function resolveTimes(body: Record<string, unknown>, base: TimeFields): TimeFields {
  const date = isISODate(body.date) ? body.date : base.date
  const allDay = has(body, "allDay", "all_day") ? Boolean(pick(body, "allDay", "all_day")) : base.allDay
  const endDateRaw = has(body, "endDate", "end_date") ? pick(body, "endDate", "end_date") : base.endDate
  const endDate = isISODate(endDateRaw) && endDateRaw > date ? endDateRaw : null
  if (allDay) return { date, endDate, allDay, start: 0, end: 24 }
  const start = toHour(pick(body, "start", "startHour", "start_hour"), base.start)
  let end = toHour(pick(body, "end", "endHour", "end_hour"), base.end)
  if (!endDate && end <= start) end = Math.min(start + 1, 24)
  return { date, endDate, allDay, start, end }
}

/** "17:30" — the legacy display column, derived from the start hour. */
function clockColumn(t: TimeFields): string | null {
  if (t.allDay) return null
  const mins = Math.round(t.start * 60)
  return `${String(Math.floor(mins / 60) % 24).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`
}

router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE household_id = ? ORDER BY date, start_hour")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToEvent))
})

router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const body = req.body as Record<string, unknown>
  const title = typeof body.title === "string" ? body.title.trim() : ""
  if (!title || !isISODate(body.date)) { res.status(400).json({ error: "title and date (yyyy-mm-dd) are required." }); return }
  const t = resolveTimes(body, { date: body.date, endDate: null, allDay: false, start: 9, end: 10 })
  // Without the Calendar permission you add events for yourself, like a café shift.
  const user = (req as AuthRequest).user
  const me = callerMember(user)
  const isManager = manages(user, "calendar")
  if (!isManager && !me) { res.status(403).json({ error: "Ask a parent to add this event." }); return }
  const memberIds = isManager ? pick(body, "memberIds", "member_ids") : [me!.id]
  const calendarId = pick(body, "calendarId", "calendar_id")
  const location = pick(body, "location")
  const repeatDays = repeatDaysColumn(pick(body, "repeatDays", "repeat_days"))
  const until = pick(body, "repeatUntil", "repeat_until")
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    `INSERT INTO events (id, household_id, calendar_id, title, date, end_date, all_day, time, start_hour, end_hour, member_ids, location,
       repeat_days, repeat_until, skip_dates, countdown, remind_minutes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, householdId, (calendarId as string) || null, title, t.date, t.endDate, t.allDay ? 1 : 0, clockColumn(t),
    t.start, t.end, JSON.stringify(Array.isArray(memberIds) ? memberIds : []), (location as string) || null,
    repeatDays, repeatDays && isISODate(until) && until >= t.date ? until : null,
    skipDatesColumn(pick(body, "skipDates", "skip_dates")),
    pick(body, "countdown") ? 1 : 0,
    reminderColumn(pick(body, "reminderMinutes", "remind_minutes")),
    me?.id ?? null,
  )
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>
  const event = rowToEvent(row)
  logActivity(req, { action: "event.create", resourceType: "event", resourceId: event.id, resourceName: event.title })
  broadcast(householdId, "events:created", event)
  res.status(201).json(event)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT * FROM events WHERE id = ? AND household_id = ?").get(id, householdId) as Record<string, unknown> | undefined
  if (!existing) { res.status(404).json({ error: "Event not found." }); return }
  const user = (req as AuthRequest).user
  if (!mayChangeEvent(user, existing)) { res.status(403).json({ error: NOT_YOURS }); return }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  // Your own event stays yours: only a parent can put other people on it.
  if (!manages(user, "calendar")) { delete body.memberIds; delete body.member_ids }
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if (has(body, "date", "endDate", "end_date", "allDay", "all_day", "start", "startHour", "start_hour", "end", "endHour", "end_hour")) {
    const cur = rowToEvent(existing)
    const t = resolveTimes(body, { date: cur.date, endDate: cur.endDate ?? null, allDay: cur.allDay, start: cur.start, end: cur.end })
    sets.push("date = ?", "end_date = ?", "all_day = ?", "time = ?", "start_hour = ?", "end_hour = ?")
    vals.push(t.date, t.endDate, t.allDay ? 1 : 0, clockColumn(t), t.start, t.end)
  }
  if (has(body, "memberIds", "member_ids")) {
    const m = pick(body, "memberIds", "member_ids")
    sets.push("member_ids = ?"); vals.push(JSON.stringify(Array.isArray(m) ? m : []))
  }
  if (has(body, "calendarId", "calendar_id")) { sets.push("calendar_id = ?"); vals.push(pick(body, "calendarId", "calendar_id") || null) }
  if ("location" in body) { sets.push("location = ?"); vals.push(body.location || null) }
  if ("countdown" in body) { sets.push("countdown = ?"); vals.push(body.countdown ? 1 : 0) }
  if (has(body, "reminderMinutes", "remind_minutes")) { sets.push("remind_minutes = ?"); vals.push(reminderColumn(pick(body, "reminderMinutes", "remind_minutes"))) }
  const repeatDays = has(body, "repeatDays", "repeat_days") ? repeatDaysColumn(pick(body, "repeatDays", "repeat_days")) : undefined
  if (repeatDays !== undefined) { sets.push("repeat_days = ?"); vals.push(repeatDays) }
  if (repeatDays === null) {
    // No longer repeating: its end date and skipped dates no longer mean anything.
    sets.push("repeat_until = ?", "skip_dates = ?"); vals.push(null, "[]")
  } else if (has(body, "repeatUntil", "repeat_until")) {
    const until = pick(body, "repeatUntil", "repeat_until")
    sets.push("repeat_until = ?"); vals.push(isISODate(until) ? until : null)
  }
  if (repeatDays !== null && has(body, "skipDates", "skip_dates")) { sets.push("skip_dates = ?"); vals.push(skipDatesColumn(pick(body, "skipDates", "skip_dates"))) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>
  const event = rowToEvent(updated)
  logActivity(req, { action: "event.update", resourceType: "event", resourceId: event.id, resourceName: event.title })
  broadcast(householdId, "events:updated", event)
  res.json(event)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const row = db.prepare("SELECT * FROM events WHERE id = ? AND household_id = ?").get(id, householdId) as Record<string, unknown> | undefined
  if (!row) { res.status(404).json({ error: "Event not found." }); return }
  if (!mayChangeEvent((req as AuthRequest).user, row)) { res.status(403).json({ error: NOT_YOURS }); return }
  const deleted = db.prepare("SELECT title FROM events WHERE id = ? AND household_id = ?").get(id, householdId) as { title: string } | undefined
  db.prepare("DELETE FROM events WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "events:deleted", id)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "event.delete", resourceType: "event", resourceId: id, resourceName: deleted?.title ?? "" })
  res.status(204).end()
})

export { router as eventsRouter }
