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
import { homeInstant } from "../lib/home-time"
import { lanBaseUrl } from "../services/invite-relay"
import { getDb, parseJson } from "../db"
import { getOrCreateSecret } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"

const router = Router()

function icsToken(householdId: string): string {
  return crypto.createHmac("sha256", getOrCreateSecret()).update(householdId).digest("hex").slice(0, 32)
}

function escapeIcs(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n")
}

const pad = (n: number) => String(n).padStart(2, "0")
const ICS_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

/** DTSTART/DTEND value for a home date plus hours since midnight, written in UTC. */
function icsDateTime(dateStr: string, hour: number): string {
  // Home time, not the hub machine's clock zone: the two can differ.
  const dt = new Date(homeInstant(dateStr, hour))
  return `${dt.getUTCFullYear()}${pad(dt.getUTCMonth() + 1)}${pad(dt.getUTCDate())}T${pad(dt.getUTCHours())}${pad(dt.getUTCMinutes())}00Z`
}

/**
 * The feed's address on the home network. Calendar apps on phones and
 * computers at home can subscribe to it; services on the internet (Google
 * Calendar's servers) can't reach a home network.
 */
function feedLink(householdId: string): { url: string; webcalUrl: string } | null {
  const lan = lanBaseUrl()
  if (!lan) return null
  const url = `${lan.replace(/\/api\/v1$/, "")}/ics/${icsToken(householdId)}`
  return { url, webcalUrl: url.replace(/^https?:/, "webcal:") }
}

/** All-day DTEND is exclusive: the day after the event's last day. */
function icsDayAfter(dateStr: string): string {
  const dt = new Date(`${dateStr}T00:00:00`)
  dt.setDate(dt.getDate() + 1)
  return `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`
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
  res.json({ token: icsToken(householdId), householdId, ...feedLink(householdId) })
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

  type EventRow = { id: string; title: string; date: string; end_date: string | null; all_day: number; repeat_days: string | null; repeat_until: string | null; skip_dates: string; start_hour: number; end_hour: number; location: string | null }
  const events = getDb()
    .prepare("SELECT id, title, date, end_date, all_day, repeat_days, repeat_until, skip_dates, start_hour, end_hour, location FROM events WHERE household_id=? ORDER BY date, start_hour")
    .all(household.id) as EventRow[]

  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Solora//Solora Hub//EN",
    `X-WR-CALNAME:${escapeIcs(household.name)}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ]

  for (const e of events) {
    const lastDay = e.end_date ?? e.date
    const dtStart = e.all_day
      ? `DTSTART;VALUE=DATE:${e.date.replace(/-/g, "")}`
      : `DTSTART:${icsDateTime(e.date, e.start_hour)}`
    const dtEnd = e.all_day
      ? `DTEND;VALUE=DATE:${icsDayAfter(lastDay)}`
      : `DTEND:${icsDateTime(lastDay, e.end_hour)}`

    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@lumora`,
      `DTSTAMP:${stamp}`,
      dtStart,
      dtEnd,
      `SUMMARY:${escapeIcs(e.title)}`,
    )
    if (e.repeat_days) {
      const byDay = e.repeat_days.split(",").map((d) => ICS_DAYS[Number(d)]).join(",")
      // UNTIL is inclusive: the end of the last allowed start day.
      const until = e.repeat_until ? `;UNTIL=${e.all_day ? e.repeat_until.replace(/-/g, "") : icsDateTime(e.repeat_until, 24)}` : ""
      lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${byDay}${until}`)
      for (const skip of parseJson<string[]>(e.skip_dates, [])) {
        lines.push(e.all_day ? `EXDATE;VALUE=DATE:${skip.replace(/-/g, "")}` : `EXDATE:${icsDateTime(skip, e.start_hour)}`)
      }
    }
    if (e.location) lines.push(`LOCATION:${escapeIcs(e.location)}`)
    lines.push("END:VEVENT")
  }

  lines.push("END:VCALENDAR")

  res.setHeader("Content-Type", "text/calendar; charset=utf-8")
  res.setHeader("Content-Disposition", `attachment; filename="${household.name}.ics"`)
  res.send(lines.join("\r\n"))
})

// GET /api/v1/ics-link — this household's feed link, for the phone's Settings.
const linkRouter = Router()
linkRouter.get("/", requireAuth, (req: Request, res: Response) => {
  const link = feedLink((req as AuthRequest).user.householdId!)
  if (!link) { res.status(503).json({ error: "The hub isn't on a network right now." }); return }
  res.json({ ...link, homeNetworkOnly: true })
})

export { router as icsRouter, linkRouter as icsLinkRouter, icsToken }
