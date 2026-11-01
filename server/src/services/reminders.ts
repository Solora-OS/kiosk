/**
 * reminders.ts — event reminders, sent by the hub at the right moment.
 *
 * Every minute the hub looks for event occurrences whose reminder time has just
 * passed and notifies the people in the event (everyone, when it's for the
 * whole family). Times are home wall-clock times, so a reminder for 5:15 PM
 * fires at 5:15 PM at home across daylight-saving changes. reminders_sent keeps
 * a restart or a slow tick from sending one twice.
 */

import { getDb, parseJson } from "../db"
import { addDaysISO, homeInstant, homeTimeZone, homeToday } from "../lib/home-time"
import { notifyMembers } from "./notify"

/** A reminder this late still goes out (a hub restart, a slow tick); older ones are dropped. */
const GRACE_MS = 10 * 60_000
/** All-day events are reminded about relative to 9 AM. */
const ALL_DAY_HOUR = 9

type EventRow = {
  id: string; household_id: string; title: string; date: string; all_day: number; start_hour: number
  repeat_days: string | null; repeat_until: string | null; skip_dates: string | null
  member_ids: string | null; location: string | null; remind_minutes: number
}

/** Whether an occurrence of `e` starts on `iso` (the apps' occurrencesOn, for start days). */
function startsOn(e: EventRow, iso: string): boolean {
  if (!e.repeat_days) return e.date === iso
  if (iso < e.date || (e.repeat_until && iso > e.repeat_until)) return false
  const [y, m, d] = iso.split("-").map(Number)
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  if (!e.repeat_days.split(",").map(Number).includes(weekday)) return false
  return !parseJson<string[]>(e.skip_dates, []).includes(iso)
}

function clock(hour: number): string {
  const mins = Math.round(hour * 60)
  const h = Math.floor(mins / 60) % 24
  return `${h % 12 === 0 ? 12 : h % 12}:${String(mins % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`
}

/** "In 30 minutes", "Starting now", "Tomorrow", "In 2 hours". */
function lead(minutes: number, allDay: boolean): string {
  if (allDay) return minutes >= 1440 ? (minutes === 1440 ? "Tomorrow" : `In ${Math.round(minutes / 1440)} days`) : "Today"
  if (minutes === 0) return "Starting now"
  if (minutes < 60) return `In ${minutes} minutes`
  if (minutes % 1440 === 0) return minutes === 1440 ? "Tomorrow" : `In ${minutes / 1440} days`
  const hours = minutes / 60
  return `In ${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"}`
}

/** Send every reminder that came due in the last few minutes. Returns how many people were notified. */
export function runReminders(now = Date.now()): number {
  const db = getDb()
  const events = db.prepare("SELECT * FROM events WHERE remind_minutes IS NOT NULL").all() as EventRow[]
  if (events.length === 0) return 0
  const tz = homeTimeZone()
  const today = homeToday(now)
  const markSent = db.prepare("INSERT OR IGNORE INTO reminders_sent (event_id, occurrence_date, member_id) VALUES (?, ?, ?)")
  let sent = 0

  for (const e of events) {
    // A reminder up to a week ahead can belong to an occurrence up to eight days out.
    const span = Math.ceil(e.remind_minutes / 1440) + 1
    for (let k = -1; k <= span; k++) {
      const day = addDaysISO(today, k)
      if (!startsOn(e, day)) continue
      const start = homeInstant(day, e.all_day ? ALL_DAY_HOUR : e.start_hour, tz)
      const fire = start - e.remind_minutes * 60_000
      if (fire > now || fire <= now - GRACE_MS) continue

      const members = (db.prepare("SELECT id FROM members WHERE household_id = ?").all(e.household_id) as { id: string }[]).map((m) => m.id)
      const listed = parseJson<string[]>(e.member_ids, []).filter((id) => members.includes(id))
      const recipients = (listed.length ? listed : members).filter((id) => markSent.run(e.id, day, id).changes > 0)
      if (recipients.length === 0) continue

      const when = e.all_day ? lead(e.remind_minutes, true) : `${lead(e.remind_minutes, false)} · ${clock(e.start_hour)}`
      notifyMembers(e.household_id, recipients, {
        title: e.title,
        body: e.location ? `${when} · ${e.location}` : when,
        time: e.all_day ? "All day" : clock(e.start_hour),
        ref: `reminder:${e.id}:${day}`,
      })
      sent += recipients.length
    }
  }
  return sent
}

let timer: ReturnType<typeof setInterval> | null = null

/** Check for due reminders every minute, starting now. */
export function startReminderScheduler(): void {
  if (timer) return
  const tick = () => {
    try {
      runReminders()
    } catch (err) {
      console.error("[reminders] tick failed:", err)
    }
  }
  tick()
  timer = setInterval(tick, 60_000)
}
