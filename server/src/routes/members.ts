import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, parseJson, toBool } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { unregisterRemoteInvite } from "../services/invite-relay"
import { notifyMembers } from "../services/notify"
import { callerMember } from "../lib/household-member"
import type { Member } from "../types"
import { logActivity } from "./activity-logs"

const router = Router()
router.use(requireAuth)

function rowToMember(r: Record<string, unknown>): Member {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    userId: (r.user_id as string) ?? undefined,
    name: r.name as string,
    initial: r.initial as string,
    color: r.color as Member["color"],
    role: r.role as Member["role"],
    dob: (r.dob as string) ?? undefined,
    account: (r.account as string) ?? undefined,
    permissions: parseJson<string[]>(r.permissions, []) as Member["permissions"],
    pending: toBool(r.pending),
    createdAt: r.created_at as string,
  }
}

// GET /members
router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!

  // Kiosk device tokens have no householdId until claimed — return empty list
  // rather than throwing a SQLite error from an undefined/null bind parameter.
  if (householdId == null || householdId === "") {
    res.json([])
    return
  }

  const rows = getDb()
    .prepare("SELECT * FROM members WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToMember))
})

// POST /members
router.post("/", (req: Request, res: Response) => {
  const { sub } = (req as AuthRequest).user
  const householdId = (req as AuthRequest).user.householdId

  if (householdId == null || householdId === "") {
    res.status(403).json({ error: "Device is not yet linked to a household." })
    return
  }

  const { name, color = "blue", role = "adult", dob, account, permissions = [], linkSelf } = req.body as {
    name?: string
    color?: string
    role?: string
    dob?: string
    account?: string
    permissions?: string[]
    linkSelf?: boolean
  }

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required." })
    return
  }

  const db = getDb()
  const id = uuidv4()
  const initial = name.trim().charAt(0).toUpperCase()
  const userId = linkSelf ? sub : null
  const accountEmail = account ?? (linkSelf ? (req as AuthRequest).user.email : null)

  db.prepare(
    `INSERT INTO members (id, household_id, user_id, name, initial, color, role, dob, account, permissions, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, householdId, userId, name.trim(), initial, color, role, dob ?? null, accountEmail ?? null, JSON.stringify(permissions))

  const row = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown>
  const member = rowToMember(row)
  logActivity(req, { action: "member.create", resourceType: "member", resourceId: member.id, resourceName: member.name })
  broadcast(householdId, "members:created", member)
  // Family news: everyone else hears about the new arrival.
  const me = callerMember((req as AuthRequest).user)?.id
  const others = (db.prepare("SELECT id FROM members WHERE household_id = ? AND id != ?").all(householdId, id) as { id: string }[])
    .map((m) => m.id)
    .filter((m) => m !== me)
  if (others.length) notifyMembers(householdId, others, { title: `${member.name} joined the family`, body: "Say hello on Solora.", ref: `member:${id}` })
  res.status(201).json(member)
})

// PATCH /members/:id
router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()

  const existing = db
    .prepare("SELECT * FROM members WHERE id = ? AND household_id = ?")
    .get(id, householdId) as Record<string, unknown> | undefined

  if (!existing) {
    res.status(404).json({ error: "Member not found." })
    return
  }

  const updates: string[] = []
  const values: unknown[] = []
  const body = req.body as Record<string, unknown>

  if (body.name !== undefined) {
    updates.push("name = ?", "initial = ?")
    values.push(String(body.name).trim(), String(body.name).trim().charAt(0).toUpperCase())
  }
  if (body.color !== undefined) { updates.push("color = ?"); values.push(body.color) }
  if (body.role !== undefined) { updates.push("role = ?"); values.push(body.role) }
  if ("dob" in body) { updates.push("dob = ?"); values.push(body.dob ?? null) }
  if ("account" in body) { updates.push("account = ?"); values.push(body.account ?? null) }
  if (body.permissions !== undefined) { updates.push("permissions = ?"); values.push(JSON.stringify(body.permissions)) }
  if (body.pending !== undefined) { updates.push("pending = ?"); values.push(body.pending ? 1 : 0) }

  if (updates.length === 0) {
    res.status(400).json({ error: "No fields to update." })
    return
  }

  values.push(id, householdId)
  db.prepare(`UPDATE members SET ${updates.join(", ")} WHERE id = ? AND household_id = ?`).run(...values)

  const updated = db.prepare("SELECT * FROM members WHERE id = ?").get(id) as Record<string, unknown>
  const member = rowToMember(updated)
  logActivity(req, { action: "member.update", resourceType: "member", resourceId: member.id, resourceName: member.name })
  broadcast(householdId, "members:updated", member)
  res.json(member)
})

// DELETE /members/:id
router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()

  const existing = db
    .prepare("SELECT id, name FROM members WHERE id = ? AND household_id = ?")
    .get(id, householdId) as { id: string; name: string } | undefined
  if (!existing) {
    res.status(404).json({ error: "Member not found." })
    return
  }

  const linked = db.prepare("SELECT user_id FROM members WHERE id = ?").get(id) as { user_id: string | null }
  const pendingInvites = db.prepare("SELECT code, token FROM invites WHERE member_id = ?").all(id) as { code: string; token: string }[]
  db.transaction(() => {
    db.prepare("DELETE FROM invites WHERE member_id = ?").run(id)
    db.prepare("DELETE FROM members WHERE id = ? AND household_id = ?").run(id, householdId)
    // A kid's phone has no account to keep; its local user goes with the member.
    if (linked.user_id) db.prepare("DELETE FROM users WHERE id = ? AND device_only = 1").run(linked.user_id)
  })()
  pendingInvites.forEach(unregisterRemoteInvite)

  logActivity(req, { action: "member.delete", resourceType: "member", resourceId: id, resourceName: existing.name })
  broadcast(householdId, "members:deleted", id)
  res.status(204).end()
})

export { router as membersRouter }
