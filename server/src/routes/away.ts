/**
 * /api/v1/away — the family is away (a trip, a holiday). While it lasts,
 * repeating chores pause in the apps and streaks don't break.
 *
 *   GET    /   → { from, until, label } or null once it's over
 *   PUT    /   (a parent) { from, until, label? }
 *   DELETE /   (a parent) back home early
 */

import { Router, type Request, type Response } from "express"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { managesChores } from "../lib/household-member"
import { hubToday } from "./chores"

export const awayRouter = Router()
awayRouter.use(requireAuth)

const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)

function current(householdId: string) {
  const row = getDb().prepare("SELECT away_from, away_until, away_label FROM households WHERE id = ?").get(householdId) as
    | { away_from: string | null; away_until: string | null; away_label: string | null }
    | undefined
  if (!row?.away_from || !row.away_until || row.away_until < hubToday()) return null
  return { from: row.away_from, until: row.away_until, label: row.away_label ?? undefined }
}

const parentOnly = (req: Request, res: Response): boolean => {
  const user = (req as AuthRequest).user
  if (user.role !== "kiosk" && managesChores(user)) return true
  res.status(403).json({ error: "A parent sets away time." })
  return false
}

awayRouter.get("/", (req: Request, res: Response) => {
  res.json(current((req as AuthRequest).user.householdId!))
})

awayRouter.put("/", (req: Request, res: Response) => {
  if (!parentOnly(req, res)) return
  const { from, until, label } = req.body as { from?: string; until?: string; label?: string }
  if (!isISODate(from) || !isISODate(until) || until < from) {
    res.status(400).json({ error: "Pick when you leave and when you're back." }); return
  }
  const householdId = (req as AuthRequest).user.householdId!
  getDb().prepare("UPDATE households SET away_from = ?, away_until = ?, away_label = ? WHERE id = ?")
    .run(from, until, typeof label === "string" && label.trim() ? label.trim().slice(0, 60) : null, householdId)
  res.json(current(householdId))
})

awayRouter.delete("/", (req: Request, res: Response) => {
  if (!parentOnly(req, res)) return
  getDb().prepare("UPDATE households SET away_from = NULL, away_until = NULL, away_label = NULL WHERE id = ?")
    .run((req as AuthRequest).user.householdId!)
  res.status(204).end()
})
