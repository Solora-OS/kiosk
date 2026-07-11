/**
 * /api/v1/hub/info — unauthenticated hub identity probe.
 *
 * Called by the mobile app right after resolving a discovered mDNS service,
 * before any auth token exists, to confirm the hub's identity and claimed
 * state before showing a claim/join form.
 *
 * Mounted on the same /api/v1/hub prefix as hub-command.ts's hubCommandRouter
 * (which applies requireAuth per-route, not at the router level), so this
 * unauthenticated route coexists safely.
 */

import { Router, type Request, type Response } from "express"
import { getDb } from "../db"
import { getOrCreateHubIdentity } from "../lib/hub-identity"

export const hubInfoRouter = Router()

hubInfoRouter.get("/info", (_req: Request, res: Response): void => {
  const identity = getOrCreateHubIdentity()
  const db = getDb()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  res.json({ hub_id: identity.id, name: identity.name, claimed: n > 0 })
})
