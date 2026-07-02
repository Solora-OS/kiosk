import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { writeLog } from "./activity-logs"
import type { CalendarEvent } from "../types"

const router = Router()
router.use(requireAuth)

function rowToEvent(r: Record<string, unknown>): CalendarEvent {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    calendarId: (r.calendar_id as string) ?? undefined,
    title: r.title as string,
    date: r.date as string,
    time: (r.time as string) ?? undefined,
    startHour: r.start_hour as number,
    endHour: r.end_hour as number,
    memberIds: parseJson<string[]>(r.member_ids, []),
    location: (r.location as string) ?? undefined,
    createdAt: r.created_at as string,
    source: (r.source as string) ?? undefined,
  }
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
  const { title, date, time, startHour = 0, endHour = 0, memberIds = [], calendarId, location } = req.body as {
    title?: string; date?: string; time?: string; startHour?: number; endHour?: number
    memberIds?: string[]; calendarId?: string; location?: string
  }
  if (!title?.trim() || !date) { res.status(400).json({ error: "title and date are required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    `INSERT INTO events (id, household_id, calendar_id, title, date, time, start_hour, end_hour, member_ids, location)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, householdId, calendarId ?? null, title.trim(), date, time ?? null, startHour, endHour, JSON.stringify(memberIds), location ?? null)
  const row = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>
  const event = rowToEvent(row)
  broadcast(householdId, "events:created", event)
  res.status(201).json(event)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT id FROM events WHERE id = ? AND household_id = ?").get(id, householdId)
  if (!existing) { res.status(404).json({ error: "Event not found." }); return }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if (body.date !== undefined) { sets.push("date = ?"); vals.push(body.date) }
  if ("time" in body) { sets.push("time = ?"); vals.push(body.time ?? null) }
  if (body.startHour !== undefined) { sets.push("start_hour = ?"); vals.push(body.startHour) }
  if (body.endHour !== undefined) { sets.push("end_hour = ?"); vals.push(body.endHour) }
  if (body.memberIds !== undefined) { sets.push("member_ids = ?"); vals.push(JSON.stringify(body.memberIds)) }
  if ("calendarId" in body) { sets.push("calendar_id = ?"); vals.push(body.calendarId ?? null) }
  if ("location" in body) { sets.push("location = ?"); vals.push(body.location ?? null) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM events WHERE id = ?").get(id) as Record<string, unknown>
  const event = rowToEvent(updated)
  broadcast(householdId, "events:updated", event)
  res.json(event)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM events WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "Event not found." }); return
  }
  const deleted = db.prepare("SELECT title FROM events WHERE id = ? AND household_id = ?").get(id, householdId) as { title: string } | undefined
  db.prepare("DELETE FROM events WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "events:deleted", id)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "event.delete", resourceType: "event", resourceId: id, resourceName: deleted?.title ?? "" })
  res.status(204).end()
})

export { router as eventsRouter }
