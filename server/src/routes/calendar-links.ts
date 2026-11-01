/**
 * /api/v1/calendar-links — calendars the family subscribes to by link.
 *
 *   GET    /           every link, with when it last synced and any problem
 *   POST   /           (Calendar permission) { url, name?, calendarId? } subscribe; reads it right away
 *   PATCH  /:id        (Calendar permission) { name?, calendarId? }
 *   POST   /:id/sync   (Calendar permission) read it again now
 *   DELETE /:id        (Calendar permission) unsubscribe and remove its events
 */

import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { manages } from "../lib/household-member"
import { fetchCalendar, linkCandidates, rowToLink, storeLinkedEvents, syncLink } from "../services/calendar-links"

const router = Router()
router.use(requireAuth)

const NOT_MANAGER = "Ask a parent to change calendar links."

function ownLink(householdId: string, id: string): Record<string, unknown> | undefined {
  return getDb().prepare("SELECT * FROM calendar_links WHERE id = ? AND household_id = ?").get(id, householdId) as Record<string, unknown> | undefined
}

function validCalendar(householdId: string, calendarId: unknown): string | null {
  if (typeof calendarId !== "string" || !calendarId) return null
  return getDb().prepare("SELECT id FROM calendars WHERE id = ? AND household_id = ?").get(calendarId, householdId) ? calendarId : null
}

router.get("/", (req: Request, res: Response) => {
  const rows = getDb().prepare("SELECT * FROM calendar_links WHERE household_id = ? ORDER BY created_at")
    .all((req as AuthRequest).user.householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToLink))
})

router.post("/", async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!manages(user, "calendar")) { res.status(403).json({ error: NOT_MANAGER }); return }
  const householdId = user.householdId!
  const body = req.body as { url?: string; name?: string; calendarId?: string }
  let candidates: string[]
  try { candidates = linkCandidates(body.url ?? "") } catch (err) { res.status(400).json({ error: (err as Error).message }); return }
  const db = getDb()
  if (candidates.some((c) => db.prepare("SELECT 1 FROM calendar_links WHERE household_id = ? AND url = ?").get(householdId, c))) {
    res.status(409).json({ error: "You're already subscribed to that calendar." }); return
  }
  // Read it first, so a bad link is refused instead of saved. Keep the address that worked.
  let feed: Awaited<ReturnType<typeof fetchCalendar>> | null = null
  let url = candidates[0]
  let problem = ""
  for (const candidate of candidates) {
    try { feed = await fetchCalendar(candidate); url = candidate; break } catch (err) { problem ||= (err as Error).message }
  }
  if (!feed) { res.status(400).json({ error: problem }); return }

  const id = uuidv4()
  const name = body.name?.trim() || feed.name || new URL(url).hostname
  const calendarId = validCalendar(householdId, body.calendarId)
  db.prepare("INSERT INTO calendar_links (id, household_id, url, name, calendar_id) VALUES (?, ?, ?, ?, ?)")
    .run(id, householdId, url, name.slice(0, 80), calendarId)
  const count = storeLinkedEvents(householdId, id, calendarId, feed.events)
  db.prepare("UPDATE calendar_links SET last_synced_at = ?, event_count = ? WHERE id = ?").run(new Date().toISOString(), count, id)
  broadcast(householdId, "events:updated", {} as never)
  res.status(201).json(rowToLink(ownLink(householdId, id)!))
})

router.patch("/:id", async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!manages(user, "calendar")) { res.status(403).json({ error: NOT_MANAGER }); return }
  const householdId = user.householdId!
  const row = ownLink(householdId, req.params.id)
  if (!row) { res.status(404).json({ error: "Calendar link not found." }); return }
  const body = req.body as { name?: string; calendarId?: string | null }
  const db = getDb()
  if (body.name?.trim()) db.prepare("UPDATE calendar_links SET name = ? WHERE id = ?").run(body.name.trim().slice(0, 80), row.id)
  if ("calendarId" in body) {
    const calendarId = validCalendar(householdId, body.calendarId)
    db.prepare("UPDATE calendar_links SET calendar_id = ? WHERE id = ?").run(calendarId, row.id)
    // Its events move with it.
    db.prepare("UPDATE events SET calendar_id = ? WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?")
      .run(calendarId, householdId, `${row.id}:%`)
    broadcast(householdId, "events:updated", {} as never)
  }
  res.json(rowToLink(ownLink(householdId, row.id as string)!))
})

router.post("/:id/sync", async (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!manages(user, "calendar")) { res.status(403).json({ error: NOT_MANAGER }); return }
  if (!ownLink(user.householdId!, req.params.id)) { res.status(404).json({ error: "Calendar link not found." }); return }
  res.json(await syncLink(req.params.id))
})

router.delete("/:id", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!manages(user, "calendar")) { res.status(403).json({ error: NOT_MANAGER }); return }
  const householdId = user.householdId!
  const row = ownLink(householdId, req.params.id)
  if (!row) { res.status(404).json({ error: "Calendar link not found." }); return }
  const db = getDb()
  db.transaction(() => {
    db.prepare("DELETE FROM events WHERE household_id = ? AND source = 'ics' AND source_event_id LIKE ?").run(householdId, `${row.id}:%`)
    db.prepare("DELETE FROM calendar_links WHERE id = ?").run(row.id)
  })()
  broadcast(householdId, "events:updated", {} as never)
  res.status(204).end()
})

export { router as calendarLinksRouter }
