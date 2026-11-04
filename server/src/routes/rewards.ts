/**
 * /api/v1/rewards — what points buy, and kids spending them.
 *
 *   GET    /                        shelf, every member's points and streak, recent redemptions
 *   POST   /                        (parents) { title, cost, icon? }
 *   PATCH  /:id                     (parents)
 *   DELETE /:id                     (parents)
 *   POST   /:id/redeem              { memberId? } spend points; kids only for themselves
 *   POST   /redemptions/:id/approve (parents)
 *   POST   /redemptions/:id/decline (parents) refunds the points
 */

import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { callerMember, managesChores } from "../lib/household-member"
import { memberPoints } from "../services/points"
import { choreManagers, notifyMembers } from "../services/notify"
import { hubToday } from "./chores"
import { logActivity, writeLog } from "./activity-logs"

export const rewardsRouter = Router()
rewardsRouter.use(requireAuth)

type Row = Record<string, unknown>

const toReward = (r: Row) => ({ id: r.id as string, title: r.title as string, cost: r.cost as number, icon: (r.icon as string) ?? undefined })
const toRedemption = (r: Row) => ({
  id: r.id as string, rewardId: (r.reward_id as string) ?? undefined, memberId: r.member_id as string,
  title: r.title as string, cost: r.cost as number, status: r.status as string, createdAt: r.created_at as string,
})

/** A parent on their own device: the only one who can approve spending (the shared wall can't). */
function isParent(user: AuthRequest["user"]): boolean {
  return user.role !== "kiosk" && managesChores(user)
}

rewardsRouter.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const db = getDb()
  res.json({
    rewards: (db.prepare("SELECT * FROM rewards WHERE household_id = ? ORDER BY cost").all(householdId) as Row[]).map(toReward),
    points: memberPoints(householdId, hubToday()),
    redemptions: (db.prepare(
      "SELECT * FROM redemptions WHERE household_id = ? ORDER BY created_at DESC LIMIT 30",
    ).all(householdId) as Row[]).map(toRedemption),
  })
})

function readReward(body: Row): { title: string; cost: number; icon: string | null } | string {
  const title = typeof body.title === "string" ? body.title.trim() : ""
  const cost = Number(body.cost)
  if (!title) return "Give the reward a name."
  if (!Number.isInteger(cost) || cost < 1 || cost > 100_000) return "Cost must be a whole number of points."
  const icon = typeof body.icon === "string" && /^[a-z0-9-]{1,32}$/.test(body.icon) ? body.icon : null
  return { title, cost, icon }
}

rewardsRouter.post("/", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!managesChores(user)) { res.status(403).json({ error: "Only a parent can add rewards." }); return }
  const r = readReward(req.body as Row)
  if (typeof r === "string") { res.status(400).json({ error: r }); return }
  const id = uuidv4()
  getDb().prepare("INSERT INTO rewards (id, household_id, title, cost, icon) VALUES (?, ?, ?, ?, ?)")
    .run(id, user.householdId, r.title, r.cost, r.icon)
  logActivity(req, { action: "reward.create", resourceType: "reward", resourceId: id, resourceName: r.title, metadata: { cost: r.cost } })
  res.status(201).json({ id, ...r, icon: r.icon ?? undefined })
})

rewardsRouter.patch("/:id", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!managesChores(user)) { res.status(403).json({ error: "Only a parent can change rewards." }); return }
  const db = getDb()
  const existing = db.prepare("SELECT * FROM rewards WHERE id = ? AND household_id = ?").get(req.params.id, user.householdId) as Row | undefined
  if (!existing) { res.status(404).json({ error: "Reward not found." }); return }
  const r = readReward({ ...existing, ...(req.body as Row) })
  if (typeof r === "string") { res.status(400).json({ error: r }); return }
  db.prepare("UPDATE rewards SET title = ?, cost = ?, icon = ? WHERE id = ?").run(r.title, r.cost, r.icon, req.params.id)
  res.json({ id: req.params.id, ...r, icon: r.icon ?? undefined })
})

rewardsRouter.delete("/:id", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  if (!managesChores(user)) { res.status(403).json({ error: "Only a parent can remove rewards." }); return }
  const gone = getDb().prepare("SELECT title FROM rewards WHERE id = ? AND household_id = ?").get(req.params.id, user.householdId) as { title: string } | undefined
  getDb().prepare("DELETE FROM rewards WHERE id = ? AND household_id = ?").run(req.params.id, user.householdId)
  if (gone) logActivity(req, { action: "reward.delete", resourceType: "reward", resourceId: req.params.id, resourceName: gone.title })
  res.status(204).end()
})

rewardsRouter.post("/:id/redeem", (req: Request, res: Response) => {
  const user = (req as AuthRequest).user
  const householdId = user.householdId!
  const db = getDb()
  const reward = db.prepare("SELECT * FROM rewards WHERE id = ? AND household_id = ?").get(req.params.id, householdId) as Row | undefined
  if (!reward) { res.status(404).json({ error: "Reward not found." }); return }

  // Kids spend only their own points; parents and the wall pick who it's for.
  const me = callerMember(user)
  const asked = (req.body as Row).memberId as string | undefined
  const memberId = managesChores(user) ? asked ?? me?.id : me?.id
  if (!memberId || (asked && asked !== memberId)) { res.status(403).json({ error: "You can only spend your own points." }); return }
  if (!db.prepare("SELECT 1 FROM members WHERE id = ? AND household_id = ?").get(memberId, householdId)) {
    res.status(404).json({ error: "Member not found." }); return
  }

  const result = db.transaction(() => {
    const balance = memberPoints(householdId, hubToday()).find((p) => p.memberId === memberId)?.balance ?? 0
    const cost = reward.cost as number
    if (balance < cost) return { error: `Not enough points yet: ${balance} of ${cost}.` }
    const id = uuidv4()
    // A parent getting it for someone is already approved; anyone else asks.
    const status = isParent(user) ? "approved" : "requested"
    db.prepare(
      "INSERT INTO redemptions (id, household_id, reward_id, member_id, title, cost, status, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, householdId, reward.id, memberId, reward.title, cost, status, status === "approved" ? new Date().toISOString() : null)
    return { redemption: toRedemption(db.prepare("SELECT * FROM redemptions WHERE id = ?").get(id) as Row) }
  })()
  if ("error" in result) { res.status(409).json({ error: result.error }); return }
  const r = result.redemption
  if (r.status === "requested") {
    // Tell the parents, so a request doesn't wait until someone opens the app.
    const who = (db.prepare("SELECT name FROM members WHERE id = ?").get(memberId) as { name: string } | undefined)?.name ?? "Someone"
    notifyMembers(householdId, choreManagers(householdId).filter((id) => id !== memberId), {
      title: `${who} wants ${r.title}`,
      body: `${r.cost} points · approve it on the rewards shelf`,
      ref: `redemption:${r.id}`,
    })
  }
  // Whoever spends the points is who asked, even when a parent or the wall taps for them.
  writeLog({ householdId, actorId: memberId, action: "reward.redeem", resourceType: "reward", resourceId: r.id, resourceName: r.title, metadata: { cost: r.cost } })
  res.status(201).json(r)
})

function decide(status: "approved" | "declined") {
  return (req: Request, res: Response) => {
    const user = (req as AuthRequest).user
    if (!isParent(user)) { res.status(403).json({ error: "A parent approves rewards on their own phone." }); return }
    const db = getDb()
    const changed = db.prepare(
      "UPDATE redemptions SET status = ?, decided_at = ? WHERE id = ? AND household_id = ? AND status = 'requested'",
    ).run(status, new Date().toISOString(), req.params.id, user.householdId)
    if (changed.changes === 0) { res.status(404).json({ error: "That request was already handled." }); return }
    const r = toRedemption(db.prepare("SELECT * FROM redemptions WHERE id = ?").get(req.params.id) as Row)
    const forName = (db.prepare("SELECT name FROM members WHERE id = ?").get(r.memberId) as { name: string } | undefined)?.name ?? ""
    logActivity(req, { action: status === "approved" ? "reward.approve" : "reward.decline", resourceType: "reward", resourceId: r.id, resourceName: r.title, metadata: { for: forName } })
    notifyMembers(user.householdId!, [r.memberId], status === "approved"
      ? { title: `${r.title}: yes!`, body: `${r.cost} points spent. Enjoy.`, ref: `redemption:${r.id}` }
      : { title: `${r.title}: not this time`, body: `Your ${r.cost} points are back.`, ref: `redemption:${r.id}` })
    res.json(r)
  }
}
rewardsRouter.post("/redemptions/:id/approve", decide("approved"))
rewardsRouter.post("/redemptions/:id/decline", decide("declined"))
