import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { writeLog } from "./activity-logs"
import type { Meal } from "../types"

const router = Router()
router.use(requireAuth)

function rowToMeal(r: Record<string, unknown>): Meal {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    memberId: (r.member_id as string) ?? undefined,
    day: r.day as string,
    name: r.name as string,
    type: r.type as string,
    image: (r.image as string) ?? undefined,
    createdAt: r.created_at as string,
  }
}

router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM meals WHERE household_id = ? ORDER BY day, created_at")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToMeal))
})

router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { day, name, type = "dinner", image, memberId } = req.body as {
    day?: string; name?: string; type?: string; image?: string; memberId?: string
  }
  if (!day || !name?.trim()) { res.status(400).json({ error: "day and name are required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO meals (id, household_id, member_id, day, name, type, image) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, householdId, memberId ?? null, day, name.trim(), type, image ?? null)
  const row = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as Record<string, unknown>
  const meal = rowToMeal(row)
  broadcast(householdId, "meals:created", meal)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "meal.create", resourceType: "meal", resourceId: id, resourceName: meal.name })
  res.status(201).json(meal)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM meals WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "Meal not found." }); return
  }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.day !== undefined) { sets.push("day = ?"); vals.push(body.day) }
  if (body.name !== undefined) { sets.push("name = ?"); vals.push(String(body.name).trim()) }
  if (body.type !== undefined) { sets.push("type = ?"); vals.push(body.type) }
  if ("image" in body) { sets.push("image = ?"); vals.push(body.image ?? null) }
  if ("memberId" in body) { sets.push("member_id = ?"); vals.push(body.memberId ?? null) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE meals SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as Record<string, unknown>
  const meal = rowToMeal(updated)
  broadcast(householdId, "meals:updated", meal)
  res.json(meal)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT name FROM meals WHERE id = ? AND household_id = ?").get(id, householdId) as { name: string } | undefined
  if (!existing) { res.status(404).json({ error: "Meal not found." }); return }
  db.prepare("DELETE FROM meals WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "meals:deleted", id)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "meal.delete", resourceType: "meal", resourceId: id, resourceName: existing.name })
  res.status(204).end()
})

export { router as mealsRouter }
