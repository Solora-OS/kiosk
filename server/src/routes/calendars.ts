import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { Calendar } from "../types"

const router = Router()
router.use(requireAuth)

function rowToCalendar(r: Record<string, unknown>): Calendar {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    name: r.name as string,
    color: r.color as Calendar["color"],
    memberIds: parseJson<string[]>(r.member_ids, []),
    createdAt: r.created_at as string,
  }
}

router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM calendars WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToCalendar))
})

router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { name, color = "blue", memberIds = [] } = req.body as {
    name?: string; color?: string; memberIds?: string[]
  }
  if (!name?.trim()) { res.status(400).json({ error: "name is required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO calendars (id, household_id, name, color, member_ids) VALUES (?, ?, ?, ?, ?)",
  ).run(id, householdId, name.trim(), color, JSON.stringify(memberIds))
  const row = db.prepare("SELECT * FROM calendars WHERE id = ?").get(id) as Record<string, unknown>
  const cal = rowToCalendar(row)
  broadcast(householdId, "calendars:created", cal)
  res.status(201).json(cal)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT id FROM calendars WHERE id = ? AND household_id = ?").get(id, householdId)
  if (!existing) { res.status(404).json({ error: "Calendar not found." }); return }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.name !== undefined) { sets.push("name = ?"); vals.push(String(body.name).trim()) }
  if (body.color !== undefined) { sets.push("color = ?"); vals.push(body.color) }
  if (body.memberIds !== undefined) { sets.push("member_ids = ?"); vals.push(JSON.stringify(body.memberIds)) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE calendars SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM calendars WHERE id = ?").get(id) as Record<string, unknown>
  const cal = rowToCalendar(updated)
  broadcast(householdId, "calendars:updated", cal)
  res.json(cal)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT id FROM calendars WHERE id = ? AND household_id = ?").get(id, householdId)
  if (!existing) { res.status(404).json({ error: "Calendar not found." }); return }
  db.prepare("DELETE FROM calendars WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "calendars:deleted", id)
  res.status(204).end()
})

export { router as calendarsRouter }
