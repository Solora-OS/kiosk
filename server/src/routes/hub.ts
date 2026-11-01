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
import { getOrCreateSetupCode } from "../lib/setup-code"
import { lanBaseUrl } from "../services/invite-relay"
import { fromThisHub } from "../lib/loopback"

export const hubInfoRouter = Router()

hubInfoRouter.get("/info", (_req: Request, res: Response): void => {
  const identity = getOrCreateHubIdentity()
  const db = getDb()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  res.json({ hub_id: identity.id, name: identity.name, claimed: n > 0 })
})

/**
 * GET /api/v1/hub/setup — the setup code and this hub's LAN address, for the
 * hub's own screen to show (and turn into a QR code a phone can scan) until a
 * household exists. Being in front of the hub is the proof of ownership, so
 * this only answers requests from this machine, and only before setup.
 */
hubInfoRouter.get("/setup", (req: Request, res: Response): void => {
  if (!fromThisHub(req)) {
    res.status(403).json({ error: "The setup code is only shown on the hub itself." })
    return
  }
  const { n } = getDb().prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  if (n > 0) {
    res.status(409).json({ error: "This hub is already set up." })
    return
  }
  res.json({ setupCode: getOrCreateSetupCode(), hubUrl: lanBaseUrl(), name: getOrCreateHubIdentity().name })
})
