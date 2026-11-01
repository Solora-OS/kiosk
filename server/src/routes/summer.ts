/**
 * /api/v1/summer — the house's summer break. While it lasts, chores follow
 * their summer rule (different days, off, or summer-only) in the apps.
 *
 *   GET    /   → { from, until } or null once it's over
 *   PUT    /   (a parent) { from, until }
 *   DELETE /   (a parent) no summer break set
 */

import { Router, type Request, type Response } from "express"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { managesChores } from "../lib/household-member"
import { hubToday } from "./chores"

export const summerRouter = Router()
summerRouter.use(requireAuth)

const isISODate = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)

/** The summer break, or null when none is set or it has ended. */
export function summerBreak(householdId: string): { from: string; until: string } | null {
  const row = getDb().prepare("SELECT summer_from, summer_until FROM households WHERE id = ?").get(householdId) as
    | { summer_from: string | null; summer_until: string | null }
    | undefined
  if (!row?.summer_from || !row.summer_until || row.summer_until < hubToday()) return null
  return { from: row.summer_from, until: row.summer_until }
}

const parentOnly = (req: Request, res: Response): boolean => {
  if (managesChores((req as AuthRequest).user)) return true
  res.status(403).json({ error: "A parent sets the summer break." })
  return false
}

summerRouter.get("/", (req: Request, res: Response) => {
  res.json(summerBreak((req as AuthRequest).user.householdId!))
})

summerRouter.put("/", (req: Request, res: Response) => {
  if (!parentOnly(req, res)) return
  const { from, until } = req.body as { from?: string; until?: string }
  if (!isISODate(from) || !isISODate(until) || until < from) {
    res.status(400).json({ error: "Pick the first and last day of the summer break." }); return
  }
  const householdId = (req as AuthRequest).user.householdId!
  getDb().prepare("UPDATE households SET summer_from = ?, summer_until = ? WHERE id = ?").run(from, until, householdId)
  broadcast(householdId, "households:updated", {} as never)
  res.json(summerBreak(householdId))
})

summerRouter.delete("/", (req: Request, res: Response) => {
  if (!parentOnly(req, res)) return
  const householdId = (req as AuthRequest).user.householdId!
  getDb().prepare("UPDATE households SET summer_from = NULL, summer_until = NULL WHERE id = ?").run(householdId)
  broadcast(householdId, "households:updated", {} as never)
  res.status(204).end()
})
