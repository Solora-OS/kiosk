import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, toBool } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { Checklist, ChecklistRow, ListItem } from "../types"

const router = Router()
router.use(requireAuth)

function fetchChecklist(id: string, householdId: string): Checklist | undefined {
  const db = getDb()
  const list = db
    .prepare("SELECT * FROM lists WHERE id = ? AND household_id = ?")
    .get(id, householdId) as Record<string, unknown> | undefined
  if (!list) return undefined
  const items = db
    .prepare("SELECT * FROM list_items WHERE list_id = ? ORDER BY position, created_at")
    .all(id) as Record<string, unknown>[]
  return {
    id: list.id as string,
    householdId: list.household_id as string,
    title: list.title as string,
    color: list.color as ChecklistRow["color"],
    createdAt: list.created_at as string,
    items: items.map((i) => ({
      id: i.id as string,
      listId: i.list_id as string,
      label: i.label as string,
      done: toBool(i.done),
      position: i.position as number,
      createdAt: i.created_at as string,
    })),
  }
}

function fetchAllLists(householdId: string): Checklist[] {
  const db = getDb()
  const lists = db
    .prepare("SELECT * FROM lists WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Record<string, unknown>[]
  return lists.map((l) => {
    const items = db
      .prepare("SELECT * FROM list_items WHERE list_id = ? ORDER BY position, created_at")
      .all(l.id as string) as Record<string, unknown>[]
    return {
      id: l.id as string,
      householdId: l.household_id as string,
      title: l.title as string,
      color: l.color as ChecklistRow["color"],
      createdAt: l.created_at as string,
      items: items.map((i) => ({
        id: i.id as string,
        listId: i.list_id as string,
        label: i.label as string,
        done: toBool(i.done),
        position: i.position as number,
        createdAt: i.created_at as string,
      })),
    }
  })
}

// GET /lists
router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  res.json(fetchAllLists(householdId))
})

// POST /lists
router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { title, color = "blue" } = req.body as { title?: string; color?: string }
  if (!title?.trim()) { res.status(400).json({ error: "title is required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare("INSERT INTO lists (id, household_id, title, color) VALUES (?, ?, ?, ?)").run(id, householdId, title.trim(), color)
  const checklist = fetchChecklist(id, householdId)!
  broadcast(householdId, "lists:created", checklist)
  res.status(201).json(checklist)
})

// PATCH /lists/:id
router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM lists WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "List not found." }); return
  }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if (body.color !== undefined) { sets.push("color = ?"); vals.push(body.color) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  db.prepare(`UPDATE lists SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  const updated = fetchChecklist(id, householdId)!
  broadcast(householdId, "lists:updated", updated)
  res.json(updated)
})

// DELETE /lists/:id
router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM lists WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "List not found." }); return
  }
  db.prepare("DELETE FROM lists WHERE id = ? AND household_id = ?").run(id, householdId)
  broadcast(householdId, "lists:deleted", id)
  res.status(204).end()
})

// POST /lists/:id/items
router.post("/:id/items", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const { label } = req.body as { label?: string }
  if (!label?.trim()) { res.status(400).json({ error: "label is required." }); return }
  const db = getDb()
  if (!db.prepare("SELECT id FROM lists WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "List not found." }); return
  }
  const maxPos = (db.prepare("SELECT MAX(position) as m FROM list_items WHERE list_id = ?").get(id) as { m: number | null }).m ?? -1
  const itemId = uuidv4()
  db.prepare("INSERT INTO list_items (id, list_id, label, done, position) VALUES (?, ?, ?, 0, ?)").run(itemId, id, label.trim(), maxPos + 1)
  const updated = fetchChecklist(id, householdId)!
  broadcast(householdId, "lists:updated", updated)
  res.status(201).json(updated)
})

// PATCH /lists/:id/items/:itemId
router.patch("/:id/items/:itemId", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id, itemId } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM lists WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "List not found." }); return
  }
  if (!db.prepare("SELECT id FROM list_items WHERE id = ? AND list_id = ?").get(itemId, id)) {
    res.status(404).json({ error: "Item not found." }); return
  }
  const sets: string[] = []; const vals: unknown[] = []
  const body = req.body as Record<string, unknown>
  if (body.label !== undefined) { sets.push("label = ?"); vals.push(String(body.label).trim()) }
  if (body.done !== undefined) { sets.push("done = ?"); vals.push(body.done ? 1 : 0) }
  if (body.position !== undefined) { sets.push("position = ?"); vals.push(body.position) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(itemId, id)
  db.prepare(`UPDATE list_items SET ${sets.join(", ")} WHERE id = ? AND list_id = ?`).run(...vals)
  const updated = fetchChecklist(id, householdId)!
  broadcast(householdId, "lists:updated", updated)
  res.json(updated)
})

// DELETE /lists/:id/items/:itemId
router.delete("/:id/items/:itemId", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id, itemId } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM lists WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "List not found." }); return
  }
  db.prepare("DELETE FROM list_items WHERE id = ? AND list_id = ?").run(itemId, id)
  const updated = fetchChecklist(id, householdId)!
  broadcast(householdId, "lists:updated", updated)
  res.json(updated)
})

export { router as listsRouter }
