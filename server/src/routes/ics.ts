// ---------------------------------------------------------------------------
// /ics/:token — public iCal feed for a household.
//
// The token is the household's device_token from kiosk_devices (or a
// dedicated ics_token we store on the household). For now we use a SHA-256
// hash of the JWT secret + household_id so there's nothing extra to store.
//
// Google Calendar / Outlook can subscribe to this URL and it will stay fresh.
// ---------------------------------------------------------------------------

import { Router, type Request, type Response } from "express"
import crypto from "crypto"
import { getDb } from "../db"
import { getOrCreateSecret } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"

const router = Router()

function icsToken(householdId: string): string {
  return crypto.createHmac("sha256", getOrCreateSecret()).update(householdId).digest("hex").slice(0, 32)
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
}

function toIcsDate(dateStr: string, timeStr: string | null): string {
  if (!timeStr) return `DTSTART;VALUE=DATE:${dateStr.replace(/-/g, "")}`
  const dt = new Date(`${dateStr}T${timeStr}:00`)
  if (isNaN(dt.getTime())) return `DTSTART;VALUE=DATE:${dateStr.replace(/-/g, "")}`
  const pad = (n: number) => String(n).padStart(2, "0")
  return `DTSTART:${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`
}

// GET /ics/token/:householdId — returns the ICS subscription URL token
router.get("/token/:householdId", requireAuth, (req: Request, res: Response) => {
  const { householdId } = req.params
  const caller = (req as AuthRequest).user
  if (caller.householdId !== householdId) {
    res.status(403).json({ error: "Forbidden." }); return
  }
  const exists = getDb().prepare("SELECT id FROM households WHERE id=?").get(householdId)
  if (!exists) { res.status(404).json({ error: "Not found." }); return }
  res.json({ token: icsToken(householdId), householdId })
})

// GET /ics/:token — unauthenticated ICS feed
router.get("/:token", async (req: Request, res: Response) => {
  const { token } = req.params

  // Look up the household by its pre-computed ICS token.
  // We compute the token for each candidate using HMAC — to avoid an O(n)
  // timing oracle, we fetch all and use timingSafeEqual for every comparison,
  // then pick the match only after checking all rows.
  const { timingSafeEqual } = await import("crypto")
  const tokenBuf = Buffer.from(token)
  const rows = getDb()
    .prepare("SELECT id, name FROM households")
    .all() as { id: string; name: string }[]

  let household: { id: string; name: string } | undefined
  for (const h of rows) {
    const candidate = Buffer.from(icsToken(h.id))
    if (candidate.length === tokenBuf.length && timingSafeEqual(candidate, tokenBuf)) {
      household = h
    }
  }
  if (!household) { res.status(404).send("Not found."); return }

  type EventRow = { id: string; title: string; date: string; time: string | null; start_hour: number; end_hour: number; location: string | null }
  const events = getDb()
    .prepare("SELECT id, title, date, time, start_hour, end_hour, location FROM events WHERE household_id=? ORDER BY date, start_hour")
    .all(household.id) as EventRow[]

  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lumora//Lumora Hub//EN",
    `X-WR-CALNAME:${escapeIcs(household.name)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ]

  for (const e of events) {
    const dtStart = toIcsDate(e.date, e.time)
    // Compute end from end_hour; if same as start or 0, make it 1 hour later.
    const endHour = e.end_hour > e.start_hour ? e.end_hour : e.start_hour + 1
    const endMin = Math.round((endHour % 1) * 60)
    const endHourInt = Math.floor(endHour)
    let dtEnd: string
    if (!e.time) {
      dtEnd = `DTEND;VALUE=DATE:${e.date.replace(/-/g, "")}`
    } else {
      const dt = new Date(`${e.date}T${e.time}:00`)
      dt.setUTCHours(endHourInt, endMin, 0, 0)
      const pad = (n: number) => String(n).padStart(2, "0")
      dtEnd = `DTEND:${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`
    }

    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@lumora`,
      `DTSTAMP:${stamp}`,
      dtStart,
      dtEnd,
      `SUMMARY:${escapeIcs(e.title)}`,
    )
    if (e.location) lines.push(`LOCATION:${escapeIcs(e.location)}`)
    lines.push("END:VEVENT")
  }

  lines.push("END:VCALENDAR")

  res.setHeader("Content-Type", "text/calendar; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${household.name}.ics"`)
  res.send(lines.join("\r\n"))
})

export { router as icsRouter, icsToken }
