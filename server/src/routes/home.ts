/**
 * /api/v1/home — the widget home screen the family arranges on the wall.
 * Stored per household, so every display shows the same home and it moves
 * with the household to a new hub.
 *
 *   GET /  → { widgets: [...] } or null (the apps then show their default)
 *   PUT /  { widgets: [{ id, type, size, config? }] }   anyone in the household, including the wall
 */

import { Router, type Request, type Response } from "express"
import { getDb, parseJson } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"

export const homeRouter = Router()
homeRouter.use(requireAuth)

const SIZES = new Set(["s", "m", "l", "full"])
type Widget = { id: string; type: string; size: string; config?: Record<string, unknown> }

/** Keeps only well-formed widgets; the apps decide which types they know. */
function cleanLayout(body: unknown): { widgets: Widget[] } | null {
  const widgets = (body as { widgets?: unknown })?.widgets
  if (!Array.isArray(widgets) || widgets.length > 40) return null
  const out: Widget[] = []
  for (const w of widgets as Record<string, unknown>[]) {
    if (typeof w?.id !== "string" || !/^[\w-]{1,40}$/.test(w.id)) return null
    if (typeof w.type !== "string" || !/^[a-z-]{1,24}$/.test(w.type)) return null
    if (typeof w.size !== "string" || !SIZES.has(w.size)) return null
    const config = w.config && typeof w.config === "object" ? (w.config as Record<string, unknown>) : undefined
    out.push({ id: w.id, type: w.type, size: w.size, ...(config ? { config } : {}) })
  }
  return { widgets: out }
}

homeRouter.get("/", (req: Request, res: Response) => {
  const row = getDb().prepare("SELECT home_layout FROM households WHERE id = ?").get((req as AuthRequest).user.householdId) as
    | { home_layout: string | null }
    | undefined
  res.json(row?.home_layout ? parseJson(row.home_layout, null) : null)
})

homeRouter.put("/", (req: Request, res: Response) => {
  const layout = cleanLayout(req.body)
  if (!layout) { res.status(400).json({ error: "That home screen layout isn't valid." }); return }
  const json = JSON.stringify(layout)
  if (json.length > 20_000) { res.status(413).json({ error: "That home screen has too much on it." }); return }
  getDb().prepare("UPDATE households SET home_layout = ? WHERE id = ?").run(json, (req as AuthRequest).user.householdId)
  res.json(layout)
})
