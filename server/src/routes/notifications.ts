import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, toBool } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { NotificationWithState } from "../types"

const router = Router()
router.use(requireAuth)

function fetchNotification(id: string, userId: string): NotificationWithState | undefined {
  const row = getDb()
    .prepare(
      `SELECT n.*, COALESCE(ns.read, 0) as read_flag
       FROM notifications n
       LEFT JOIN notification_states ns ON ns.notification_id = n.id AND ns.user_id = ?
       WHERE n.id = ?`,
    )
    .get(userId, id) as (Record<string, unknown> & { read_flag: number }) | undefined
  if (!row) return undefined
  return {
    id: row.id as string,
    householdId: row.household_id as string,
    memberId: (row.member_id as string) ?? undefined,
    title: row.title as string,
    body: row.body as string,
    time: row.time as string,
    createdAt: row.created_at as string,
    read: toBool(row.read_flag),
  }
}

// GET /notifications
router.get("/", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare(
      `SELECT n.*, COALESCE(ns.read, 0) as read_flag
       FROM notifications n
       LEFT JOIN notification_states ns ON ns.notification_id = n.id AND ns.user_id = ?
       WHERE n.household_id = ?
         AND (ns.dismissed IS NULL OR ns.dismissed = 0)
       ORDER BY n.created_at DESC`,
    )
    .all(sub, householdId) as (Record<string, unknown> & { read_flag: number })[]

  res.json(
    rows.map((r) => ({
      id: r.id as string,
      householdId: r.household_id as string,
      memberId: (r.member_id as string) ?? undefined,
      title: r.title as string,
      body: r.body as string,
      time: r.time as string,
      createdAt: r.created_at as string,
      read: toBool(r.read_flag),
    })),
  )
})

// POST /notifications
router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { title, body = "", time = "", memberId } = req.body as {
    title?: string; body?: string; time?: string; memberId?: string
  }
  if (!title?.trim()) { res.status(400).json({ error: "title is required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO notifications (id, household_id, member_id, title, body, time) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, householdId, memberId ?? null, title.trim(), body, time)
  const notif = fetchNotification(id, (req as AuthRequest).user.sub)!
  broadcast(householdId, "notifications:created", notif)
  res.status(201).json(notif)
})

// PATCH /notifications/:id
router.patch("/:id", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const existing = db.prepare("SELECT id FROM notifications WHERE id = ? AND household_id = ?").get(id, householdId)
  if (!existing) { res.status(404).json({ error: "Notification not found." }); return }

  const body = req.body as Record<string, unknown>

  // Update shared content fields
  const sets: string[] = []; const vals: unknown[] = []
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if (body.body !== undefined) { sets.push("body = ?"); vals.push(body.body) }
  if (body.time !== undefined) { sets.push("time = ?"); vals.push(body.time) }
  if (sets.length > 0) {
    vals.push(id, householdId)
    db.prepare(`UPDATE notifications SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
  }

  // Update per-user read state
  if (body.read !== undefined) {
    db.prepare(
      `INSERT INTO notification_states (notification_id, user_id, read)
       VALUES (?, ?, ?)
       ON CONFLICT(notification_id, user_id) DO UPDATE SET read = excluded.read`,
    ).run(id, sub, body.read ? 1 : 0)
  }

  const notif = fetchNotification(id, sub)!
  broadcast(householdId, "notifications:updated", notif)
  res.json(notif)
})

// DELETE /notifications/:id — dismiss for this user only
router.delete("/:id", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  if (!db.prepare("SELECT id FROM notifications WHERE id = ? AND household_id = ?").get(id, householdId)) {
    res.status(404).json({ error: "Notification not found." }); return
  }
  db.prepare(
    `INSERT INTO notification_states (notification_id, user_id, dismissed)
     VALUES (?, ?, 1)
     ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed = 1`,
  ).run(id, sub)
  broadcast(householdId, "notifications:deleted", id)
  res.status(204).end()
})

// POST /notifications/read-all
router.post("/read-all", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId!
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM notifications WHERE household_id = ?")
    .all(householdId) as { id: string }[]
  for (const row of rows) {
    db.prepare(
      `INSERT INTO notification_states (notification_id, user_id, read)
       VALUES (?, ?, 1)
       ON CONFLICT(notification_id, user_id) DO UPDATE SET read = 1`,
    ).run(row.id, sub)
  }
  res.status(204).end()
})

// DELETE /notifications — clear all (dismiss all for this user)
router.delete("/", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId!
  const db = getDb()
  const rows = db
    .prepare("SELECT id FROM notifications WHERE household_id = ?")
    .all(householdId) as { id: string }[]
  for (const row of rows) {
    db.prepare(
      `INSERT INTO notification_states (notification_id, user_id, dismissed)
       VALUES (?, ?, 1)
       ON CONFLICT(notification_id, user_id) DO UPDATE SET dismissed = 1`,
    ).run(row.id, sub)
  }
  res.status(204).end()
})

export { router as notificationsRouter }
