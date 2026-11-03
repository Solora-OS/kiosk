/**
 * /api/v1/wall — a phone standing next to a wall display.
 *
 *   POST /near            { tag?, rssi }   a phone heard a wall's Bluetooth beacon up close
 *   POST /throw           { kind, id }     pinch to throw: show this on the wall you're at
 *   POST /presence-token                   a long-lived pass that can only call /near
 *
 * Each wall broadcasts a Bluetooth beacon carrying `tag`, the first 8 hex digits
 * of its device id (kiosk/src-tauri/src/beacon.rs). A phone with Solora open
 * hears it, and once the signal says it's right there it reports here over the
 * home Wi-Fi with its own member token, so the beacon itself carries no secret.
 * The hub tells that wall someone walked up ("wall:approach"); a wall asleep in
 * quiet hours wakes for them.
 *
 * Throwing only works from a phone that reported being near a wall in the last
 * NEAR_MS, and lands on that wall ("wall:throw").
 *
 * With the app closed, the phone's own Bluetooth code reports /near with a
 * presence pass instead of the member's session, which expires daily.
 */

import { Router, type Request, type Response } from "express"
import { getDb } from "../db"
import { requireAuth, requireAuthOrPresence, signPresenceToken, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { WallThrowKind } from "../types"

export const wallRouter = Router()

/** How long after a sighting a phone still counts as standing at that wall. */
const NEAR_MS = 30_000
/** At most one approach event per member per wall in this window. */
const APPROACH_EVERY_MS = 5_000

type Near = { deviceIds: string[]; at: number; announcedAt: number }

/** member id → the walls their phone last heard up close. In memory: it only matters for seconds. */
const nearBy = new Map<string, Near>()

const tagOf = (deviceId: string) => deviceId.replace(/[^0-9a-f]/gi, "").slice(0, 8).toLowerCase()

/** The calling phone's member, or a response already sent. */
function memberOf(req: Request, res: Response): { id: string; name: string; color: string; householdId: string } | null {
  const user = (req as AuthRequest).user
  if (user.role === "kiosk" || !user.householdId) {
    res.status(403).json({ error: "Only a family member's phone can do this." })
    return null
  }
  const row = getDb()
    .prepare("SELECT id, name, color FROM members WHERE user_id = ? AND household_id = ?")
    .get(user.userId, user.householdId) as { id: string; name: string; color: string } | undefined
  if (!row) {
    res.status(403).json({ error: "You're not in this family yet." })
    return null
  }
  return { ...row, householdId: user.householdId }
}

wallRouter.post("/presence-token", requireAuth, (req: Request, res: Response) => {
  const member = memberOf(req, res)
  if (!member) return
  const user = (req as AuthRequest).user
  res.json({ token: signPresenceToken({ userId: user.userId, householdId: member.householdId }) })
})

wallRouter.post("/near", requireAuthOrPresence, (req: Request, res: Response) => {
  const member = memberOf(req, res)
  if (!member) return
  const { tag, rssi } = req.body as { tag?: unknown; rssi?: unknown }
  if (tag != null && (typeof tag !== "string" || !/^[0-9a-f]{8}$/i.test(tag))) {
    res.status(400).json({ error: "tag must be 8 hex digits." })
    return
  }
  if (typeof rssi !== "number" || !Number.isFinite(rssi) || rssi > 0 || rssi < -127) {
    res.status(400).json({ error: "rssi must be a number from -127 to 0." })
    return
  }

  // A beacon without a tag (or an older wall) means "a wall here": with one
  // wall in the house that's unambiguous, and waking every wall is harmless.
  const walls = getDb()
    .prepare("SELECT id FROM kiosk_devices WHERE household_id = ?")
    .all(member.householdId) as { id: string }[]
  const deviceIds = walls.map((w) => w.id).filter((id) => !tag || tagOf(id) === tag.toLowerCase())
  if (deviceIds.length === 0) {
    // Someone else's wall (a neighbour's, a friend's house): not ours to wake.
    res.json({ ok: true, walls: [] })
    return
  }

  const now = Date.now()
  const prev = nearBy.get(member.id)
  const sameWalls = prev && prev.deviceIds.join() === deviceIds.join()
  const announce = !sameWalls || now - prev.announcedAt >= APPROACH_EVERY_MS
  nearBy.set(member.id, { deviceIds, at: now, announcedAt: announce ? now : prev!.announcedAt })

  if (announce) {
    broadcast(member.householdId, "wall:approach", {
      deviceIds,
      member: { id: member.id, name: member.name, color: member.color },
    })
  }
  res.json({ ok: true, walls: deviceIds })
})

const THROW_KINDS: Record<WallThrowKind, string> = {
  photo: "SELECT 1 FROM photos WHERE id = ? AND household_id = ?",
  list: "SELECT 1 FROM lists WHERE id = ? AND household_id = ?",
}

wallRouter.post("/throw", requireAuth, (req: Request, res: Response) => {
  const member = memberOf(req, res)
  if (!member) return
  const { kind, id } = req.body as { kind?: unknown; id?: unknown }
  if (typeof kind !== "string" || !(kind in THROW_KINDS)) {
    res.status(400).json({ error: "kind must be photo or list." })
    return
  }
  if (typeof id !== "string" || !id) {
    res.status(400).json({ error: "id is required." })
    return
  }
  const near = nearBy.get(member.id)
  if (!near || Date.now() - near.at > NEAR_MS) {
    res.status(409).json({ error: "Walk up to the wall display first, then throw." })
    return
  }
  if (!getDb().prepare(THROW_KINDS[kind as WallThrowKind]).get(id, member.householdId)) {
    res.status(404).json({ error: "That isn't in this family's hub." })
    return
  }

  broadcast(member.householdId, "wall:throw", {
    deviceIds: near.deviceIds,
    kind: kind as WallThrowKind,
    id,
    from: { id: member.id, name: member.name, color: member.color },
  })
  res.json({ ok: true, walls: near.deviceIds })
})
