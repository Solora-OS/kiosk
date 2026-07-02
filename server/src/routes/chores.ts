import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, toBool } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { Chore } from "../types"

const router = Router()
router.use(requireAuth)

function rowToChore(r: Record<string, unknown>): Chore {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    memberId: (r.member_id as string) ?? undefined,
    title: r.title as string,
    done: toBool(r.done),
    points: r.points as number,
    due: r.due as string,
    createdAt: r.created_at as string,
  }
}

router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM chores WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToChore))
})

router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { title, memberId, done = false, points = 0, due = "" } = req.body as {
    title?: string; memberId?: string; done?: boolean; points?: number; due?: string
  }
  if (!title?.trim()) { res.status(400).json({ error: "title is required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO chores (id, household_id, member_id, title, done, points, due) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, householdId, memberId ?? null, title.trim(), done ? 1 : 0, points, due)
  const row = db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown>
  const chore = rowToChore(row)
  broadcast(householdId, "chores:created", chore)
  res.status(201).json(chore)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM chores WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "Chore not found." }); return
  }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if ("memberId" in body) { sets.push("member_id = ?"); vals.push(body.memberId ?? null) }
  if (body.done !== undefined) { sets.push("done = ?"); vals.push(body.done ? 1 : 0) }
  if (body.points !== undefined) { sets.push("points = ?"); vals.push(body.points) }
  if (body.due !== undefined) { sets.push("due = ?"); vals.push(body.due) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE chores SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown>
  const chore = rowToChore(updated)
  broadcast(householdId, "chores:updated", chore)
  res.json(chore)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM chores WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "Chore not found." }); return
  }
  db.prepare("DELETE FROM chores WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "chores:deleted", id)
  res.status(204).end()
})

export { router as choresRouter }
