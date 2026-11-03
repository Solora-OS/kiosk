/**
 * auth.ts — JWT authentication middleware for Express routes and Socket.IO.
 *
 * Two token kinds are accepted:
 *  - Device tokens (kiosk/hub):  HS256, signed with on-disk secret at ~/.lumora/.secret
 *  - User tokens (central):      ES256, signed by Solora central (see lib/account-tokens.ts)
 *
 * Detection: account tokens have iss="lumora-central", aud="lumora-users".
 * Device tokens have no iss field.
 */

import type { Request, Response, NextFunction } from "express"
import jwt from "jsonwebtoken"
import type { Socket } from "socket.io"
import { getOrCreateSecret, getDb } from "../db"
import type { JwtPayload, ServerToClientEvents, ClientToServerEvents, SocketData } from "../types"
import { isAccountToken, verifyAccountToken } from "../lib/account-tokens"

export type AuthRequest = Request & {
  user: JwtPayload & { userId: string }
}

// ---------------------------------------------------------------------------
// Device token helpers (kiosk / hub — unchanged)
// ---------------------------------------------------------------------------

/** Sign a new device access token. Pass expiresIn to override default 24h. */
export function signToken(
  payload: Omit<JwtPayload, "iat" | "exp">,
  expiresIn: string = "24h",
): string {
  return jwt.sign(payload, getOrCreateSecret(), {
    algorithm: "HS256",
    expiresIn,
  } as jwt.SignOptions)
}

/** Sign a device refresh token (30d expiry by default). It only works at the refresh endpoint. */
export function signRefreshToken(payload: Omit<JwtPayload, "iat" | "exp">, expiresIn: string = "30d"): string {
  return jwt.sign({ ...payload, typ: "refresh" }, getOrCreateSecret(), {
    algorithm: "HS256",
    expiresIn,
  } as jwt.SignOptions)
}

/** Verify and decode a device access token. Throws on invalid/expired tokens and on refresh / presence tokens. */
export function verifyToken(token: string): JwtPayload {
  const payload = jwt.verify(token, getOrCreateSecret(), {
    algorithms: ["HS256"],
  }) as JwtPayload
  if (payload.typ === "refresh") throw new jwt.JsonWebTokenError("Refresh tokens can't be used for access.")
  if (payload.typ === "presence") throw new jwt.JsonWebTokenError("Presence passes only work at the wall.")
  return payload
}

/**
 * A phone's long-lived presence pass (routes/wall.ts): lets the phone's own
 * Bluetooth code say "I'm at the wall" while the app is closed, and nothing
 * else. Every other route and the socket refuse it (verifyToken).
 */
export function signPresenceToken(user: { userId: string; householdId: string }): string {
  return jwt.sign({ sub: user.userId, householdId: user.householdId, role: "member", typ: "presence" }, getOrCreateSecret(), {
    algorithm: "HS256",
    expiresIn: "365d",
  } as jwt.SignOptions)
}

/** requireAuth, but also accepting a presence pass. Only for POST /wall/near. */
export function requireAuthOrPresence(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : ""
  let payload: JwtPayload | null = null
  try {
    if (token && !isAccountToken(token)) payload = jwt.verify(token, getOrCreateSecret(), { algorithms: ["HS256"] }) as JwtPayload
  } catch { /* not ours: requireAuth answers */ }
  if (payload?.typ !== "presence") {
    requireAuth(req, res, next)
    return
  }
  if (!memberStillLinked(payload)) {
    res.status(401).json({ error: "This phone has been signed out of the household." })
    return
  }
  ;(req as AuthRequest).user = { ...payload, userId: payload.sub }
  next()
}

/**
 * Access + refresh tokens for a phone signed in without an account (a kid's
 * phone). The refresh token rolls forward on every use, so a phone that's
 * opened at least once a year never has to be set up again.
 */
export function signMemberDeviceTokens(user: { id: string; householdId: string; name: string }): {
  token: string
  refreshToken: string
} {
  const payload = { sub: user.id, householdId: user.householdId, name: user.name, role: "member" as const }
  return { token: signToken(payload, "24h"), refreshToken: signRefreshToken(payload, "365d") }
}

/** Verify and decode a device refresh token. Throws unless it is one. */
export function verifyRefreshToken(token: string): JwtPayload {
  const payload = jwt.verify(token, getOrCreateSecret(), {
    algorithms: ["HS256"],
  }) as JwtPayload
  if (payload.typ !== "refresh") throw new jwt.JsonWebTokenError("Not a refresh token.")
  return payload
}

/**
 * A hub-issued member token (a kid's phone, the relay acting for a user, kiosk
 * auto-login) is only good while its local user still exists. Removing a kid
 * from the family deletes their account-less user, which signs their phone out.
 */
function memberStillLinked(payload: JwtPayload): boolean {
  if (payload.role !== "member") return true
  return !!getDb()
    .prepare("SELECT 1 FROM users WHERE id = ? AND household_id = ?")
    .get(payload.sub, payload.householdId ?? "")
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * requireAuth — resolves req.user from either a central account token or a
 * device (kiosk/hub) token. Responds 401 on missing/invalid tokens.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header." })
    return
  }
  const token = header.slice(7).trim()

  if (isAccountToken(token)) {
    // Async path — verify central account JWT
    void verifyAccountToken(token).then((payload) => {
      if (!payload) {
        res.status(401).json({ error: "Invalid or expired token." })
        return
      }
      // Look up local user record by account_id to get householdId
      const db = getDb()
      const row = db
        .prepare("SELECT id, household_id, name, email FROM users WHERE account_id = ?")
        .get(payload.sub) as { id: string; household_id: string; name: string; email: string } | undefined

      ;(req as AuthRequest).user = {
        sub:         row?.id ?? payload.sub,
        userId:      row?.id ?? payload.sub,
        householdId: row?.household_id,
        email:       row?.email ?? payload.email,
        name:        row?.name ?? payload.name,
        role:        "member",
      }
      next()
    })
    return
  }

  // Device token path (kiosk / hub — synchronous)
  try {
    const payload = verifyToken(token)

    if (payload.role === "kiosk" && !payload.householdId) {
      const row = getDb()
        .prepare("SELECT household_id FROM kiosk_devices WHERE id = ?")
        .get(payload.sub) as { household_id: string | null } | undefined
      if (row?.household_id) payload.householdId = row.household_id
    }
    if (!memberStillLinked(payload)) {
      res.status(401).json({ error: "This phone has been signed out of the household." })
      return
    }

    ;(req as AuthRequest).user = { ...payload, userId: payload.sub }
    next()
  } catch (err) {
    const msg = err instanceof jwt.TokenExpiredError ? "Token expired." : "Invalid token."
    res.status(401).json({ error: msg })
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = (req as AuthRequest).user
  if (!user) { res.status(401).json({ error: "Authentication required." }); return }
  const db = getDb()
  const member = db
    .prepare("SELECT role FROM members WHERE user_id = ? AND household_id = ?")
    .get(user.userId, user.householdId) as { role: string } | undefined
  if (!member || member.role !== "admin") {
    res.status(403).json({ error: "Admin access required." })
    return
  }
  next()
}

// ---------------------------------------------------------------------------
// Socket.IO middleware
// ---------------------------------------------------------------------------

type AuthenticatedSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

export function socketAuth(
  socket: AuthenticatedSocket,
  next: (err?: Error) => void,
): void {
  const token = socket.handshake.auth?.token as string | undefined
  if (!token) {
    next(new Error("UNAUTHORIZED: No token provided."))
    return
  }

  if (isAccountToken(token)) {
    void verifyAccountToken(token).then((payload) => {
      if (!payload) { next(new Error("UNAUTHORIZED: Invalid account token.")); return }
      const db = getDb()
      const row = db
        .prepare("SELECT id, household_id, name, email FROM users WHERE account_id = ?")
        .get(payload.sub) as { id: string; household_id: string; name: string; email: string } | undefined

      socket.data.userId      = row?.id ?? payload.sub
      socket.data.householdId = row?.household_id ?? ""
      socket.data.email       = row?.email ?? payload.email
      socket.data.name        = row?.name ?? payload.name
      next()
    })
    return
  }

  try {
    const payload = verifyToken(token)
    let householdId = payload.householdId ?? ""
    if (payload.role === "kiosk" && !householdId) {
      const row = getDb()
        .prepare("SELECT household_id FROM kiosk_devices WHERE id = ?")
        .get(payload.sub) as { household_id: string | null } | undefined
      householdId = row?.household_id ?? ""
    }
    if (!memberStillLinked(payload)) { next(new Error("UNAUTHORIZED: Signed out of the household.")); return }
    socket.data.userId      = payload.sub
    socket.data.householdId = householdId
    socket.data.email       = payload.email ?? ""
    socket.data.name        = payload.name ?? ""
    next()
  } catch (err) {
    const msg = err instanceof jwt.TokenExpiredError ? "EXPIRED" : "UNAUTHORIZED"
    next(new Error(`${msg}: ${(err as Error).message}`))
  }
}
