import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { writeLog } from "./activity-logs"
import { manages } from "../lib/household-member"
import type { Meal } from "../types"

const router = Router()
router.use(requireAuth)

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** Up to 60 trimmed, non-empty grocery lines. */
function ingredientsColumn(value: unknown): string {
  const lines = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : []
  return JSON.stringify(lines.map((l) => String(l).trim().slice(0, 80)).filter(Boolean).slice(0, 60))
}

export function rowToMeal(r: Record<string, unknown>): Meal {
  return {
    date: (r.date as string) ?? undefined,
    ingredients: parseJson<string[]>(r.ingredients, []),
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
  if (!manages((req as AuthRequest).user, "meals")) { res.status(403).json({ error: "Ask a parent to change the meal plan." }); return }
  const householdId = (req as AuthRequest).user.householdId!
  const { name, type = "dinner", image, memberId, date, ingredients } = req.body as {
    day?: string; name?: string; type?: string; image?: string; memberId?: string; date?: string; ingredients?: unknown
  }
  // A dated menu also records its weekday, so older apps still place it.
  const day = isISODate(date) ? DAYS[new Date(`${date}T00:00:00`).getDay()] : (req.body as { day?: string }).day
  if (!day || !name?.trim()) { res.status(400).json({ error: "day (or date) and name are required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO meals (id, household_id, member_id, day, name, type, image, date, ingredients) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, householdId, memberId ?? null, day, name.trim(), type, image ?? null, isISODate(date) ? date : null, ingredientsColumn(ingredients))
  const row = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as Record<string, unknown>
  const meal = rowToMeal(row)
  broadcast(householdId, "meals:created", meal)
  writeLog({ householdId, actorId: (req as AuthRequest).user.sub, action: "meal.create", resourceType: "meal", resourceId: id, resourceName: meal.name })
  res.status(201).json(meal)
})

router.patch("/:id", (req: Request, res: Response) => {
  if (!manages((req as AuthRequest).user, "meals")) { res.status(403).json({ error: "Ask a parent to change the meal plan." }); return }
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
  if ("date" in body) {
    const date = isISODate(body.date) ? body.date : null
    sets.push("date = ?"); vals.push(date)
    if (date) { sets.push("day = ?"); vals.push(DAYS[new Date(`${date}T00:00:00`).getDay()]) }
  }
  if ("ingredients" in body) { sets.push("ingredients = ?"); vals.push(ingredientsColumn(body.ingredients)) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE meals SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = db.prepare("SELECT * FROM meals WHERE id = ?").get(id) as Record<string, unknown>
  const meal = rowToMeal(updated)
  broadcast(householdId, "meals:updated", meal)
  res.json(meal)
})

router.delete("/:id", (req: Request, res: Response) => {
  if (!manages((req as AuthRequest).user, "meals")) { res.status(403).json({ error: "Ask a parent to change the meal plan." }); return }
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
