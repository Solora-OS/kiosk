/**
 * /api/v1/kiosk — device registration, pairing state, setup and heartbeat.
 *
 * These endpoints are called by the Tauri kiosk app itself (not a user account).
 * POST /register — no auth required (device has no token yet)
 * GET  /state    — requires device token in Authorization header
 * POST /setup    — requires device token
 * POST /heartbeat — requires device token
 * POST /unpair   — requires device token
 */

import { Router, type Request, type Response } from "express"
import crypto from "crypto"
import { getDb } from "../db"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { signToken } from "../middleware/auth"

export const kioskRouter = Router()

// ---------------------------------------------------------------------------
// POST /register — create a new unregistered device row, return device token
// ---------------------------------------------------------------------------
kioskRouter.post("/register", (req: Request, res: Response): void => {
  const db = getDb()
  const deviceName: string = (req.body?.device_name as string | undefined)?.trim() || "Kiosk Display"

  const id = crypto.randomUUID()
  const pairingCode = genPairingCode()

  // Sign a long-lived JWT so the device can authenticate all future requests.
  // We store the device id (sub) in the token; the raw hex is kept in the DB
  // as a secondary lookup key in case the JWT is ever reissued.
  // 10-year expiry — a kiosk device should never need to re-register just
  // because its token expired.
  const deviceJwt = signToken(
    { sub: id, role: "kiosk", name: deviceName },
    "87600h", // 10 years
  )

  // Store a SHA-256 hash of the JWT, not the raw token, so a DB breach
  // doesn't expose device credentials.
  const tokenHash = crypto.createHash("sha256").update(deviceJwt).digest("hex")

  db.prepare(
    `INSERT INTO kiosk_devices
     (id, device_token, device_name, pairing_code, setup_complete, is_online, last_heartbeat)
     VALUES (?, ?, ?, ?, 0, 1, datetime('now'))`,
  ).run(id, tokenHash, deviceName, pairingCode)

  // Return the raw JWT to the device — it will never be stored on the server again.
  res.status(201).json({ id, device_token: deviceJwt, pairing_code: pairingCode })
})

// ---------------------------------------------------------------------------
// GET /state — return current pairing state for the device
// ---------------------------------------------------------------------------
kioskRouter.get("/state", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  // The device token is validated as a Bearer JWT by requireAuth.
  // We use req.user.userId which is the device row id for kiosk tokens.
  const deviceId = req.user!.userId

  const row = db
    .prepare("SELECT * FROM kiosk_devices WHERE id = ?")
    .get(deviceId) as Record<string, unknown> | undefined

  if (!row) {
    res.json({ found: false })
    return
  }

  const household = row.household_id
    ? (db.prepare("SELECT id, name FROM households WHERE id = ?").get(row.household_id) as
        | Record<string, unknown>
        | undefined)
    : undefined

  res.json({
    found: true,
    device_id: row.id,
    device_name: row.device_name,
    paired: !!row.household_id,
    pairing_code: row.pairing_code ?? null,
    household_id: row.household_id ?? null,
    household_name: household?.name ?? null,
    setup_complete: !!row.setup_complete,
    language: row.language ?? null,
    timezone: row.timezone ?? null,
  })
})

// ---------------------------------------------------------------------------
// POST /setup — mark setup complete and save device preferences
// ---------------------------------------------------------------------------
kioskRouter.post("/setup", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const deviceId = req.user!.userId
  const { device_name, language, timezone } = req.body as {
    device_name?: string
    language?: string
    timezone?: string
  }

  db.prepare(
    `UPDATE kiosk_devices
     SET device_name = COALESCE(?, device_name),
         language = COALESCE(?, language),
         timezone = COALESCE(?, timezone),
         setup_complete = 1
     WHERE id = ?`,
  ).run(device_name ?? null, language ?? null, timezone ?? null, deviceId)

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// POST /heartbeat — update live metrics for this device
// ---------------------------------------------------------------------------
kioskRouter.post("/heartbeat", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const deviceId = req.user!.userId
  const { wifi_signal, ping_latency_ms, battery_percent, device_info } = req.body as {
    wifi_signal?: number
    ping_latency_ms?: number
    battery_percent?: number | null
    device_info?: string | null
  }

  db.prepare(
    `UPDATE kiosk_devices
     SET wifi_signal = COALESCE(?, wifi_signal),
         ping_latency_ms = COALESCE(?, ping_latency_ms),
         battery_percent = ?,
         device_info = COALESCE(?, device_info),
         is_online = 1,
         last_heartbeat = datetime('now')
     WHERE id = ?`,
  ).run(
    wifi_signal ?? null,
    ping_latency_ms ?? null,
    battery_percent ?? null,
    device_info ?? null,
    deviceId,
  )

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// GET /devices — list all kiosk devices paired to the caller's household
//
// Called by iOS / mobile clients with a user JWT.
// ---------------------------------------------------------------------------
kioskRouter.get("/devices", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const { householdId } = req.user!

  if (!householdId) {
    res.json([])
    return
  }

  const rows = db
    .prepare(
      `SELECT id, device_name, household_id,
              ping_latency_ms AS ping_ms,
              battery_percent AS battery_pct,
              wifi_signal,
              last_heartbeat
       FROM kiosk_devices
       WHERE household_id = ?`,
    )
    .all(householdId) as Record<string, unknown>[]

  res.json(
    rows.map((r) => ({
      device_id: r.id as string,
      device_name: (r.device_name as string | null) ?? "Lumora Kiosk",
      household_id: r.household_id as string,
      ping_ms: r.ping_ms != null ? Number(r.ping_ms) : null,
      battery_pct: r.battery_pct != null ? Number(r.battery_pct) : null,
      wifi_signal: r.wifi_signal != null ? Number(r.wifi_signal) : null,
      last_heartbeat: (r.last_heartbeat as string | null) ?? null,
    })),
  )
})

// ---------------------------------------------------------------------------
// DELETE /devices/:deviceId — unpair a kiosk from the household (user JWT)
//
// A household member can unpair any device belonging to their household.
// ---------------------------------------------------------------------------
kioskRouter.delete("/devices/:deviceId", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const { householdId } = req.user!
  const { deviceId } = req.params

  if (!householdId) {
    res.status(403).json({ error: "Only authenticated household members can unpair a device." })
    return
  }

  const device = db
    .prepare("SELECT id FROM kiosk_devices WHERE id = ? AND household_id = ?")
    .get(deviceId, householdId) as { id: string } | undefined

  if (!device) {
    res.status(404).json({ error: "Device not found in your household." })
    return
  }

  const newCode = genPairingCode()
  db.prepare(
    `UPDATE kiosk_devices
     SET household_id = NULL, pairing_code = ?, setup_complete = 0
     WHERE id = ?`,
  ).run(newCode, deviceId)

  res.status(204).end()
})

// ---------------------------------------------------------------------------
// POST /claim — household member claims a device by pairing code
//
// Called by a member (user JWT in Authorization header), not the device.
// Body: { pairing_code: "SQJ-PT3" }
// ---------------------------------------------------------------------------
kioskRouter.post("/claim", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const { householdId, sub: userId } = req.user!

  if (!householdId) {
    res.status(403).json({ error: "Only authenticated household members can claim a device." })
    return
  }

  const raw: string = ((req.body as Record<string, unknown>)?.pairing_code as string | undefined)?.trim().toUpperCase() ?? ""
  if (!raw) {
    res.status(400).json({ error: "pairing_code is required." })
    return
  }

  // Normalise: accept with or without the dash (e.g. "SQJPT3" or "SQJ-PT3")
  const pairingCode = raw.includes("-") ? raw : `${raw.slice(0, 3)}-${raw.slice(3)}`

  const device = db
    .prepare("SELECT id, household_id, device_name FROM kiosk_devices WHERE pairing_code = ?")
    .get(pairingCode) as { id: string; household_id: string | null; device_name: string } | undefined

  if (!device) {
    res.status(404).json({ error: "Pairing code not found. Check the code shown on the hub screen." })
    return
  }

  if (device.household_id && device.household_id !== householdId) {
    res.status(409).json({ error: "This hub is already claimed by a different household." })
    return
  }

  // Link device to household and clear the pairing code so it cannot be reused.
  db.prepare(
    `UPDATE kiosk_devices
     SET household_id = ?, pairing_code = NULL
     WHERE id = ?`,
  ).run(householdId, device.id)

  // Return the household info so the caller can confirm.
  const household = db
    .prepare("SELECT id, name FROM households WHERE id = ?")
    .get(householdId) as { id: string; name: string } | undefined

  res.json({
    ok: true,
    device_id: device.id,
    device_name: device.device_name,
    household_id: householdId,
    household_name: household?.name ?? null,
    claimed_by: userId,
  })
})

// ---------------------------------------------------------------------------
// POST /unpair — detach from household, issue fresh pairing code
// ---------------------------------------------------------------------------
kioskRouter.post("/unpair", requireAuth, (req: Request, res: Response): void => {
  const db = getDb()
  const deviceId = req.user!.userId
  const newCode = genPairingCode()

  db.prepare(
    `UPDATE kiosk_devices
     SET household_id = NULL, pairing_code = ?, setup_complete = 0
     WHERE id = ?`,
  ).run(newCode, deviceId)

  res.json({ ok: true, pairing_code: newCode })
})

// ---------------------------------------------------------------------------
// POST /heartbeat (alias under /kiosk-devices/heartbeat for kiosk-status.ts)
// ---------------------------------------------------------------------------
kioskRouter.post("/kiosk-devices/heartbeat", requireAuth, (req: Request, res: Response): void => {
  // Forwarded to the same handler — just re-invoke the heartbeat logic.
  const db = getDb()
  const deviceId = req.user!.userId
  const { wifi_signal, ping_latency_ms, battery_percent, device_info } = req.body as Record<string, unknown>

  db.prepare(
    `UPDATE kiosk_devices
     SET wifi_signal = COALESCE(?, wifi_signal),
         ping_latency_ms = COALESCE(?, ping_latency_ms),
         battery_percent = ?,
         device_info = COALESCE(?, device_info),
         is_online = 1,
         last_heartbeat = datetime('now')
     WHERE id = ?`,
  ).run(
    wifi_signal ?? null,
    ping_latency_ms ?? null,
    battery_percent ?? null,
    device_info ?? null,
    deviceId,
  )

  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genPairingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
  const bytes = require("crypto").randomBytes(6) as Buffer
  const code = Array.from(bytes, (b: number) => chars[b % chars.length]).join("")
  return `${code.slice(0, 3)}-${code.slice(3, 6)}`
}

// ---------------------------------------------------------------------------
// GET /central-token/:localDeviceId
// Returns the central API JWT for a kiosk device so it can connect to the
// central socket server. Called by the kiosk app on startup.
// Auth: device JWT (the kiosk's own token from this local hub).
// ---------------------------------------------------------------------------
import { getCentralKioskToken, registerKioskWithCentral } from "../lib/central-registry"

kioskRouter.get("/central-token/:localDeviceId", requireAuth, (req: Request, res: Response): void => {
  const { localDeviceId } = req.params
  const token = getCentralKioskToken(localDeviceId)
  if (!token) {
    res.status(503).json({ error: "Central registration pending — retry in a few seconds" })
    return
  }
  res.json({ token })
})

// ---------------------------------------------------------------------------
// POST /request-central-token
// Lets a kiosk self-trigger its own central API registration on demand.
// Called when GET /central-token returns 503 (hub missed the kiosk on startup).
// Auth: device JWT (the kiosk's own token).
// ---------------------------------------------------------------------------
kioskRouter.post("/request-central-token", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const localDeviceId = (req as AuthRequest).user?.userId
  if (!localDeviceId) { res.status(400).json({ error: "Could not resolve device ID from token" }); return }

  // Check if already registered
  const existing = getCentralKioskToken(localDeviceId)
  if (existing) { res.json({ token: existing }); return }

  const token = await registerKioskWithCentral(localDeviceId)
  if (!token) {
    res.status(503).json({ error: "Hub could not reach the central API — check CENTRAL_API_URL and ensure the hub is registered" })
    return
  }
  res.json({ token })
})

// Re-export signToken so kiosk device tokens can be issued
export { signToken }
