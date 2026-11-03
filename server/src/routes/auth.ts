/**
 * routes/auth.ts — hub side of account sign-in.
 *
 * User identity is owned by Solora central (POST /auth/signup, /auth/login…).
 * The hub validates central's access tokens and provisions a local user +
 * household row on first sign-in.
 *
 * POST /auth/session   — exchange a central access token for local session info
 *                        (creates local user + household if first time)
 * GET  /auth/session   — return current session info from validated token
 * GET  /auth/me        — alias for GET /auth/session
 *
 * Sign-up, sign-in, refresh and password changes happen against central
 * directly; the hub never sees a password.
 */

import { Router } from "express"
import { v4 as uuidv4 } from "uuid"
import crypto from "crypto"
import fs from "fs"
import path from "path"
import os from "os"
import { getDb, getOrCreateSecret } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { verifyAccountToken } from "../lib/account-tokens"
import { getHubJwt } from "../lib/central-registry"
import { signMemberDeviceTokens, signToken, verifyRefreshToken } from "../middleware/auth"
import { setupCodeMatches } from "../lib/setup-code"
import jwt from "jsonwebtoken"
import type { Request, Response } from "express"

/** 32-byte AES-256-GCM key for E2E encrypting off-network relay payloads. */
export function getRemoteKey(): Buffer {
  return crypto.createHmac("sha256", getOrCreateSecret()).update("lumora-remote-access").digest()
}

const router = Router()

// ---------------------------------------------------------------------------
// POST /auth/session
// Provision a local user + household from a central access token.
// Call this once after signing in to central to bootstrap the local record.
// ---------------------------------------------------------------------------
router.post("/session", async (req: Request, res: Response) => {
  const { access_token, household_name, setupCode } = req.body as {
    access_token?: string
    household_name?: string
    setupCode?: string
  }

  if (!access_token) {
    res.status(400).json({ error: "access_token is required." })
    return
  }

  const payload = await verifyAccountToken(access_token)
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token. Sign in again." })
    return
  }

  const db = getDb()
  const accountId = payload.sub
  const email = payload.email
  const name = payload.name || email.split("@")[0] || "User"

  // Check if local user already exists
  let user = db
    .prepare("SELECT id, household_id, name, email FROM users WHERE account_id = ?")
    .get(accountId) as { id: string; household_id: string; name: string; email: string } | undefined

  if (!user) {
    // First sign-in — require the hub's one-time setup code so no other Solora
    // account on the network can provision a household here. It's shown on the
    // hub's screen (see lib/setup-code.ts).
    if (!setupCodeMatches(setupCode)) {
      res.status(403).json({ error: "That setup code doesn't match. It's shown on your hub's screen." })
      return
    }

    // This hub already has a household — the activation screen's "claimed"
    // check should have kept us from getting here, but guard against a race
    // (e.g. two people activating the same hub at once) rather than silently
    // provisioning a second household.
    const { n: existingHouseholds } = db
      .prepare("SELECT COUNT(*) AS n FROM households")
      .get() as { n: number }
    if (existingHouseholds > 0) {
      res.status(409).json({ error: "This hub already has a household. Sign in instead of creating a new one." })
      return
    }

    // Provision local user + household
    const userId      = uuidv4()
    const householdId = uuidv4()
    const memberId    = uuidv4()
    const calendarId  = uuidv4()
    const hhName      = household_name?.trim() || `${name}'s Family`

    db.transaction(() => {
      db.prepare("INSERT INTO households (id, name) VALUES (?, ?)").run(householdId, hhName)

      db.prepare(
        "INSERT INTO users (id, household_id, email, name, account_id) VALUES (?, ?, ?, ?, ?)",
      ).run(userId, householdId, email, name, accountId)

      db.prepare(
        `INSERT INTO members (id, household_id, user_id, name, initial, color, role, permissions, account)
         VALUES (?, ?, ?, ?, ?, 'blue', 'admin', '[]', ?)`,
      ).run(memberId, householdId, userId, name, name.charAt(0).toUpperCase(), email)

      db.prepare(
        `INSERT INTO calendars (id, household_id, name, color, member_ids)
         VALUES (?, ?, 'Family', 'blue', ?)`,
      ).run(calendarId, householdId, JSON.stringify([memberId]))

      // The hub's own screen joins the new household, so it doesn't ask to be
      // paired right after showing the setup code. Other displays still pair.
      db.prepare("UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE household_id IS NULL AND on_hub = 1")
        .run(householdId)
    })()

    user = { id: userId, household_id: householdId, name, email }
    console.log(`[auth] Provisioned local user  account_id=${accountId}  user_id=${userId}`)
  }

  const household = db
    .prepare("SELECT id, name FROM households WHERE id = ?")
    .get(user.household_id) as { id: string; name: string }

  // Decode the hub's own JWT to get central hub_id (sub field)
  const hubJwt = getHubJwt()
  const hubId  = hubJwt ? (jwt.decode(hubJwt) as { sub?: string } | null)?.sub ?? null : null

  res.json({
    user:      { id: user.id, email: user.email, name: user.name },
    household: { id: household.id, name: household.name },
    remoteKey: getRemoteKey().toString("hex"),
    hubId,
  })
})

// ---------------------------------------------------------------------------
// GET /auth/session  (and /auth/me)
// Returns the current user + household from the validated Bearer token.
// ---------------------------------------------------------------------------
router.get(["/session", "/me"], requireAuth, (req: Request, res: Response) => {
  const { sub, householdId, email, name, role } = (req as AuthRequest).user
  const db = getDb()

  if (role === "kiosk") {
    const device = db
      .prepare("SELECT id, device_name, household_id FROM kiosk_devices WHERE id = ?")
      .get(sub) as { id: string; device_name: string; household_id: string | null } | undefined

    const household = device?.household_id
      ? (db.prepare("SELECT id, name FROM households WHERE id = ?").get(device.household_id) as
          | { id: string; name: string }
          | undefined)
      : undefined

    res.json({
      user:      { id: sub, email: null, name: device?.device_name ?? name ?? "Kiosk" },
      household: household ?? null,
      isKiosk:   true,
    })
    return
  }

  const household = householdId
    ? (db.prepare("SELECT id, name FROM households WHERE id = ?").get(householdId) as
        | { id: string; name: string }
        | undefined)
    : undefined

  if (!household) {
    res.status(404).json({ error: "Household not found. Call POST /auth/session to provision." })
    return
  }

  res.json({
    user:      { id: sub, email, name },
    household: { id: household.id, name: household.name },
  })
})

// ---------------------------------------------------------------------------
// POST /auth/kiosk-autologin
// Called by the kiosk frontend to sign in without embedding credentials in
// the frontend bundle. The hub server reads credentials from a secure file:
//   ~/.lumora/kiosk-autologin.json  →  { "account_id": "<central account uuid>" }
// The file must be created manually on the hub machine during setup.
// Returns { enabled: false } if the file doesn't exist (no auto-login configured).
// ---------------------------------------------------------------------------
router.post("/kiosk-autologin", async (_req: Request, res: Response) => {
  const configPath = path.join(os.homedir(), ".lumora", "kiosk-autologin.json")

  let config: { account_id?: string } = {}
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8")) as { account_id?: string }
  } catch {
    res.json({ enabled: false })
    return
  }

  if (!config.account_id) {
    res.json({ enabled: false })
    return
  }

  const db = getDb()
  const user = db
    .prepare("SELECT id, household_id, name, email FROM users WHERE account_id = ?")
    .get(config.account_id) as { id: string; household_id: string; name: string; email: string } | undefined

  if (!user) {
    res.status(404).json({ error: "No local user found for configured account_id. Sign in manually first." })
    return
  }

  const household = db
    .prepare("SELECT id, name FROM households WHERE id = ?")
    .get(user.household_id) as { id: string; name: string } | undefined

  if (!household) {
    res.status(404).json({ error: "Household not found." })
    return
  }

  const token = signToken(
    { sub: user.id, householdId: household.id, email: user.email, name: user.name, role: "member" },
    "24h",
  )

  res.json({
    token,
    user:      { id: user.id, email: user.email, name: user.name },
    household: { id: household.id, name: household.name },
  })
})

// ---------------------------------------------------------------------------
// POST /auth/device-refresh
// A phone signed in without an account (see POST /invites/claim-device) swaps
// its refresh token for a new pair. Fails once the member is removed.
// ---------------------------------------------------------------------------
router.post("/device-refresh", (req: Request, res: Response) => {
  const { refresh_token } = req.body as { refresh_token?: string }
  if (!refresh_token) {
    res.status(400).json({ error: "refresh_token is required." })
    return
  }
  let sub: string
  try {
    sub = verifyRefreshToken(refresh_token).sub
  } catch {
    res.status(401).json({ error: "Sign-in expired. Ask a parent for a new invite." })
    return
  }
  const user = getDb()
    .prepare("SELECT id, household_id, name FROM users WHERE id = ? AND device_only = 1")
    .get(sub) as { id: string; household_id: string; name: string } | undefined
  if (!user) {
    res.status(401).json({ error: "This phone has been signed out of the household." })
    return
  }
  res.json(signMemberDeviceTokens({ id: user.id, householdId: user.household_id, name: user.name }))
})

export { router as authRouter }
