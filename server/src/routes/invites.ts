import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import crypto from "crypto"
import { getDb } from "../db"
import { requireAuth, signMemberDeviceTokens, type AuthRequest } from "../middleware/auth"
import { verifyAccountToken } from "../lib/account-tokens"
import { getRemoteKey } from "./auth"
import { getHubJwt } from "../lib/central-registry"
import jwt from "jsonwebtoken"
import type { Invite } from "../types"
import { lanBaseUrl, registerRemoteInvite, unregisterRemoteInvite } from "../services/invite-relay"

const router = Router()

function inviteCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = crypto.randomBytes(6)
  const code = Array.from(bytes, b => chars[b % chars.length]).join("")
  return `${code.slice(0, 3)}-${code.slice(3, 6)}`
}

function rowToInvite(r: Record<string, unknown>): Invite {
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    memberId: r.member_id as string,
    token: r.token as string,
    code: r.code as string,
    name: r.name as string,
    role: r.role as Invite["role"],
    color: r.color as Invite["color"],
    dob: (r.dob as string) ?? undefined,
    email: (r.email as string) ?? undefined,
    expiresAt: r.expires_at as string,
    createdAt: r.created_at as string,
  }
}

// POST /invites — create invite (authenticated)
router.post("/", requireAuth, (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const { name, role = "adult", color = "blue", dob, email } = req.body as {
    name?: string
    role?: string
    color?: string
    dob?: string
    memberId?: string
    member_id?: string
    email?: string
  }
  // The kiosk has sent snake_case; reading only memberId made every invite for an
  // existing member insert a second, pending copy of them.
  const memberId = (req.body.memberId ?? req.body.member_id ?? undefined) as string | undefined

  if (!name?.trim()) {
    res.status(400).json({ error: "name is required." })
    return
  }

  const db = getDb()
  let finalMemberId = memberId

  if (finalMemberId) {
    const exists = db.prepare("SELECT 1 FROM members WHERE id = ? AND household_id = ?").get(finalMemberId, householdId)
    if (!exists) {
      res.status(404).json({ error: "That member no longer exists." })
      return
    }
    // Update existing member slot to pending
    const patch: unknown[] = []
    const sets: string[] = ["pending = 1"]
    if (email) { sets.push("account = ?"); patch.push(email) }
    patch.push(finalMemberId, householdId)
    db.prepare(`UPDATE members SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...patch)
  } else {
    // Create a pending member slot
    finalMemberId = uuidv4()
    db.prepare(
      `INSERT INTO members (id, household_id, name, initial, color, role, dob, account, permissions, pending)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 1)`,
    ).run(finalMemberId, householdId, name.trim(), name.trim().charAt(0).toUpperCase(), color, role, dob ?? null, email ?? null)
  }

  // Drop stale invite for this member slot
  const stale = db.prepare("SELECT code, token FROM invites WHERE member_id = ?").all(finalMemberId) as { code: string; token: string }[]
  db.prepare("DELETE FROM invites WHERE member_id = ?").run(finalMemberId)
  stale.forEach(unregisterRemoteInvite)

  const id = uuidv4()
  const token = `inv_${uuidv4().replace(/-/g, "")}`
  const code = inviteCode()
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

  db.prepare(
    `INSERT INTO invites (id, household_id, member_id, token, code, name, role, color, dob, email, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, householdId, finalMemberId, token, code, name.trim(), role, color, dob ?? null, email ?? null, expiresAt)

  const row = db.prepare("SELECT * FROM invites WHERE id = ?").get(id) as Record<string, unknown>
  registerRemoteInvite({ code, token, expiresAt })
  res.status(201).json(rowToInvite(row))
})

// GET /invites/:tokenOrCode — look up an invite (no auth required for claim flow)
// ---------------------------------------------------------------------------
// Tap to invite. Bluetooth hands over a short-lived ticket, never the invite:
// any phone in Bluetooth range could read what's offered. The ticket only
// turns into the invite once the inviting phone approves, after the person
// checks the 4-digit number the new phone shows. First phone to answer holds
// the ticket; denying it kills it, and the inviter taps again.
// ---------------------------------------------------------------------------

type TapTicket = {
  inviteId: string
  householdId: string
  expiresAt: number
  state: "open" | "requested" | "approved" | "denied"
  check: string | null
}

const tapTickets = new Map<string, TapTicket>()
const TAP_TTL_MS = 3 * 60_000
/** Time the new phone has to finish its profile once approved. */
const TAP_CLAIM_MS = 15 * 60_000

function liveTicket(id: string): TapTicket | null {
  const t = tapTickets.get(id)
  if (!t) return null
  if (t.expiresAt < Date.now()) {
    tapTickets.delete(id)
    unregisterRemoteInvite({ code: id, token: id })
    return null
  }
  return t
}

// POST /invites/:id/tap — the inviting phone starts offering this invite nearby.
router.post("/:id/tap", requireAuth, (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const invite = getDb().prepare("SELECT id FROM invites WHERE id = ? AND household_id = ?").get(req.params.id, householdId)
  if (!invite) {
    res.status(404).json({ error: "Invite not found." })
    return
  }
  const ticket = `tap_${crypto.randomBytes(16).toString("hex")}`
  const expiresAt = Date.now() + TAP_TTL_MS
  tapTickets.set(ticket, { inviteId: req.params.id, householdId: householdId!, expiresAt, state: "open", check: null })
  // So a phone that isn't on this Wi-Fi can still answer through central.
  registerRemoteInvite({ code: ticket, token: ticket, expiresAt: new Date(expiresAt).toISOString() })
  res.status(201).json({ ticket, expiresAt: new Date(expiresAt).toISOString() })
})

// GET /invites/:id/tap/:ticket — the inviting phone watches for an answer.
router.get("/:id/tap/:ticket", requireAuth, (req: Request, res: Response) => {
  const t = liveTicket(req.params.ticket)
  if (!t || t.inviteId !== req.params.id || t.householdId !== (req as AuthRequest).user.householdId) {
    res.status(404).json({ error: "This tap invite timed out." })
    return
  }
  res.json({ state: t.state, check: t.check })
})

// POST /invites/:id/tap/:ticket/approve | deny — the inviter decides.
router.post("/:id/tap/:ticket/:decision(approve|deny)", requireAuth, (req: Request, res: Response) => {
  const t = liveTicket(req.params.ticket)
  if (!t || t.inviteId !== req.params.id || t.householdId !== (req as AuthRequest).user.householdId) {
    res.status(404).json({ error: "This tap invite timed out." })
    return
  }
  if (t.state !== "requested") {
    res.status(409).json({ error: "No phone is waiting on this invite." })
    return
  }
  if (req.params.decision === "approve") {
    t.state = "approved"
    t.expiresAt = Date.now() + TAP_CLAIM_MS
  } else {
    t.state = "denied"
  }
  res.json({ state: t.state })
})

/**
 * A new phone asking with "tap_<ticket>.<4 digits>". Returns the invite row
 * once approved; null after answering with a pending/refused status.
 */
function tapLookup(key: string, res: Response): Record<string, unknown> | null {
  const [ticketId, check = ""] = key.toLowerCase().split(".")
  const t = liveTicket(ticketId)
  if (!t || t.state === "denied") {
    res.status(404).json({ error: "This tap invite was cancelled or timed out. Ask them to tap again." })
    return null
  }
  if (!/^\d{4}$/.test(check)) {
    res.status(400).json({ error: "Missing check number." })
    return null
  }
  if (t.state === "open") {
    t.state = "requested"
    t.check = check
  }
  if (t.check !== check) {
    res.status(409).json({ error: "Another phone answered this invite first. Ask them to tap again." })
    return null
  }
  if (t.state !== "approved") {
    res.status(202).json({ pending: true, check })
    return null
  }
  const row = getDb()
    .prepare("SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.id = ?")
    .get(t.inviteId) as Record<string, unknown> | undefined
  if (!row) res.status(404).json({ error: "Invite not found or already used." })
  return row ?? null
}

router.get("/:tokenOrCode", (req: Request, res: Response) => {
  const key = req.params.tokenOrCode.trim()
  const db = getDb()

  let row: (Record<string, unknown> & { household_name: string }) | undefined
  if (/^tap_/i.test(key)) {
    row = tapLookup(key, res) as typeof row
    if (!row) return
  } else {
    row = (
      db.prepare("SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE i.token = ?").get(key) ??
      db.prepare("SELECT i.*, h.name AS household_name FROM invites i JOIN households h ON h.id = i.household_id WHERE UPPER(i.code) = UPPER(?)").get(key)
    ) as (Record<string, unknown> & { household_name: string }) | undefined
  }

  if (!row) {
    res.status(404).json({ error: "Invite not found or expired." })
    return
  }

  if (new Date(row.expires_at as string) < new Date()) {
    res.status(410).json({ error: "This invite has expired." })
    return
  }

  res.json({
    ...rowToInvite(row),
    householdName: row.household_name,
    memberName: row.name,
  })
})

// POST /invites/claim — link a Solora account to a pending member slot.
// The client must have already signed up / signed in with central and passes
// the resulting access_token here; the hub never sees the password.
router.post("/claim", async (req: Request, res: Response) => {
  const { token, access_token, name, dob, color } = req.body as {
    token?: string
    access_token?: string
    name?: string
    dob?: string
    color?: string
  }

  if (!token || !access_token || !name?.trim()) {
    res.status(400).json({ error: "token, access_token and name are required." })
    return
  }

  const payload = await verifyAccountToken(access_token)
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token. Sign in again." })
    return
  }

  const db = getDb()
  const invite = db
    .prepare("SELECT * FROM invites WHERE token = ?")
    .get(token) as Record<string, unknown> | undefined

  if (!invite) {
    res.status(404).json({ error: "Invite not found or already used." })
    return
  }
  if (new Date(invite.expires_at as string) < new Date()) {
    res.status(410).json({ error: "This invite has expired." })
    return
  }

  const accountId = payload.sub
  const email = payload.email.toLowerCase()
  const householdId = invite.household_id as string

  // Reuse the existing local user if this account is already provisioned
  // here (e.g. re-claiming an invite for a second member slot, or a retry).
  const byAccountId = db
    .prepare("SELECT id, household_id FROM users WHERE account_id = ?")
    .get(accountId) as { id: string; household_id: string } | undefined

  // Legacy row not yet linked to a central account (hub-local password or
  // Supabase-era user) — upgrade it in place instead of inserting, since
  // `email` is UNIQUE and would otherwise collide. The invite token for this
  // household is what authorises taking it over.
  const legacy = !byAccountId
    ? (db
        .prepare("SELECT id, household_id FROM users WHERE email = ? AND account_id IS NULL")
        .get(email) as { id: string; household_id: string } | undefined)
    : undefined

  const existing = byAccountId ?? legacy

  if (existing && existing.household_id !== householdId) {
    res.status(409).json({ error: "This account is already linked to a different household." })
    return
  }

  const userId = existing?.id ?? uuidv4()

  db.transaction(() => {
    if (legacy) {
      db.prepare("UPDATE users SET account_id = ?, password_hash = NULL WHERE id = ?").run(accountId, legacy.id)
    } else if (!byAccountId) {
      db.prepare(
        "INSERT INTO users (id, household_id, email, name, account_id) VALUES (?, ?, ?, ?, ?)",
      ).run(userId, householdId, email, name.trim(), accountId)
    }

    // Claim the member slot
    db.prepare(
      "UPDATE members SET user_id = ?, name = ?, initial = ?, dob = ?, color = ?, account = ?, pending = 0 WHERE id = ?",
    ).run(userId, name.trim(), name.trim().charAt(0).toUpperCase(), dob ?? null, color ?? invite.color, email, invite.member_id)

    // Consume the invite
    db.prepare("DELETE FROM invites WHERE id = ?").run(invite.id)
  })()
  unregisterRemoteInvite({ code: invite.code as string, token: invite.token as string })

  const household = db
    .prepare("SELECT id, name FROM households WHERE id = ?")
    .get(householdId) as { id: string; name: string }

  // Central hub_id (the hub JWT's sub) — the phone needs it for relay routing.
  const hubJwt = getHubJwt()
  const hubId = hubJwt ? (jwt.decode(hubJwt) as { sub?: string } | null)?.sub ?? null : null

  res.status(201).json({
    user: { id: userId, email, name: name.trim() },
    household,
    remoteKey: getRemoteKey().toString("hex"),
    hubId,
    lanUrl: lanBaseUrl(),
  })
})

// POST /invites/claim-device — join a child or teen's member slot without an
// email or account. The hub creates a local user for the member and returns
// tokens for this phone only; the invite token is what authorises it.
router.post("/claim-device", (req: Request, res: Response) => {
  const { token, name, dob, color } = req.body as { token?: string; name?: string; dob?: string; color?: string }
  if (!token || !name?.trim()) {
    res.status(400).json({ error: "token and name are required." })
    return
  }

  const db = getDb()
  const invite = db.prepare("SELECT * FROM invites WHERE token = ?").get(token) as Record<string, unknown> | undefined
  if (!invite) {
    res.status(404).json({ error: "Invite not found or already used." })
    return
  }
  if (new Date(invite.expires_at as string) < new Date()) {
    res.status(410).json({ error: "This invite has expired." })
    return
  }
  if (invite.role !== "child" && invite.role !== "teen") {
    res.status(403).json({ error: "Adults join with an email address." })
    return
  }

  const householdId = invite.household_id as string
  const memberId = invite.member_id as string
  const trimmed = name.trim()
  // email is UNIQUE NOT NULL; a reserved .invalid address keeps that constraint
  // without ever being mistaken for a real inbox.
  const userId = uuidv4()
  const placeholderEmail = `member-${userId}@device.invalid`

  db.transaction(() => {
    db.prepare(
      "INSERT INTO users (id, household_id, email, name, device_only) VALUES (?, ?, ?, ?, 1)",
    ).run(userId, householdId, placeholderEmail, trimmed)
    db.prepare(
      "UPDATE members SET user_id = ?, name = ?, initial = ?, dob = ?, color = ?, account = NULL, pending = 0 WHERE id = ?",
    ).run(userId, trimmed, trimmed.charAt(0).toUpperCase(), dob ?? null, color ?? invite.color, memberId)
    db.prepare("DELETE FROM invites WHERE id = ?").run(invite.id)
  })()
  unregisterRemoteInvite({ code: invite.code as string, token: invite.token as string })

  const household = db.prepare("SELECT id, name FROM households WHERE id = ?").get(householdId) as { id: string; name: string }
  const hubJwt = getHubJwt()
  const hubId = hubJwt ? (jwt.decode(hubJwt) as { sub?: string } | null)?.sub ?? null : null

  res.status(201).json({
    user: { id: userId, email: null, name: trimmed },
    household,
    remoteKey: getRemoteKey().toString("hex"),
    hubId,
    lanUrl: lanBaseUrl(),
    ...signMemberDeviceTokens({ id: userId, householdId, name: trimmed }),
  })
})

// DELETE /invites/:id — revoke / cancel an outstanding invite (authenticated)
router.delete("/:id", requireAuth, (req: Request, res: Response) => {
  const { householdId } = (req as AuthRequest).user
  const { id } = req.params
  const db = getDb()

  const invite = db
    .prepare("SELECT id, member_id, code, token FROM invites WHERE id = ? AND household_id = ?")
    .get(id, householdId) as { id: string; member_id: string; code: string; token: string } | undefined

  if (!invite) {
    res.status(404).json({ error: "Invite not found." })
    return
  }

  db.transaction(() => {
    db.prepare("DELETE FROM invites WHERE id = ?").run(invite.id)
    // Clear the pending flag on the member slot so it stops showing "Invited".
    db.prepare("UPDATE members SET pending = 0 WHERE id = ? AND household_id = ?")
      .run(invite.member_id, householdId)
  })()
  unregisterRemoteInvite(invite)

  res.status(204).end()
})

export { router as invitesRouter }
