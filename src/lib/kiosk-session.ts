// ---------------------------------------------------------------------------
// kiosk-session.ts
//
// Kiosk pairing session — local server edition.
//
// A kiosk device identifies itself with a `device_token` persisted in
// localStorage. All pairing / state RPCs that previously hit Supabase now
// call the local Express server at http://localhost:4000/api/v1/kiosk/*.
//
// Lifecycle:
//   unregistered  -> no token stored. Call ensureRegistered() to create one.
//   unpaired      -> token exists, but no household has claimed it.
//                    Shows a pairing code / QR for a family member to scan.
//   paired        -> a household member claimed the code.
//                    GET /api/v1/snapshot now returns the household data.
// ---------------------------------------------------------------------------

import { LOCAL_API_BASE } from "./local-api"

const TOKEN_KEY      = "lumora.kiosk.deviceToken"
const NAME_KEY       = "lumora.kiosk.deviceName"
const DEVICE_ID_KEY  = "lumora.device.id"

let _registerPromise: Promise<string | null> | null = null

export type KioskState = {
  found: boolean
  deviceId: string | null
  deviceName: string
  paired: boolean
  pairingCode: string | null
  householdId: string | null
  householdName: string | null
  setupComplete: boolean
  language: string | null
  timezone: string | null
}

const UNPAIRED: KioskState = {
  found: false,
  deviceId: null,
  deviceName: "Kiosk Display",
  paired: false,
  pairingCode: null,
  householdId: null,
  householdName: null,
  setupComplete: false,
  language: null,
  timezone: null,
}

// ---------------------------------------------------------------------------
// Token / name helpers
// ---------------------------------------------------------------------------

export function getDeviceToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}

function setDeviceToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
    // Decode the JWT payload (no verification needed — just need the sub/device_id)
    const payload = JSON.parse(atob(token.split('.')[1])) as { sub?: string }
    if (payload.sub) localStorage.setItem(DEVICE_ID_KEY, payload.sub)
  } catch { /* noop */ }
}

/** Returns the local hub device UUID. Falls back to decoding the stored JWT if the ID key is missing (handles devices that registered before this key was introduced). */
export function getLocalDeviceId(): string | null {
  try {
    const stored = localStorage.getItem(DEVICE_ID_KEY)
    if (stored) return stored
    // Backfill from the existing device JWT
    const token = localStorage.getItem(TOKEN_KEY)
    if (!token) return null
    const payload = JSON.parse(atob(token.split('.')[1])) as { sub?: string }
    if (payload.sub) {
      localStorage.setItem(DEVICE_ID_KEY, payload.sub)
      return payload.sub
    }
    return null
  } catch { return null }
}

function clearDeviceToken() {
  try { localStorage.removeItem(TOKEN_KEY) } catch { /* noop */ }
}

export function getDeviceName(): string {
  try { return localStorage.getItem(NAME_KEY) || "Kiosk Display" } catch { return "Kiosk Display" }
}

export function setDeviceName(name: string) {
  try { localStorage.setItem(NAME_KEY, name) } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Local server helpers
// ---------------------------------------------------------------------------

async function kioskReq<T>(path: string, method: string, body?: unknown): Promise<T> {
  const token = getDeviceToken()
  const res = await fetch(`${LOCAL_API_BASE}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    console.log('tauri win loc', window.location.href)
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Ensure this device has a token. Registers a fresh unclaimed device on first
 * launch. Uses a module-level promise lock to prevent race conditions.
 */
/** True if the stored token looks like a real HS256 JWT (3 dot-separated parts). */
function isJwt(token: string): boolean {
  return token.split(".").length === 3
}

export async function ensureRegistered(deviceName?: string): Promise<string | null> {
  const existing = getDeviceToken()
  // Discard legacy raw hex tokens from older builds — they are not JWTs
  // and will always be rejected by the server's requireAuth middleware.
  if (existing && isJwt(existing)) return existing
  if (existing && !isJwt(existing)) {
    console.warn("[kiosk-session] Discarding non-JWT device token, re-registering.")
    clearDeviceToken()
  }

  if (_registerPromise) return _registerPromise

  _registerPromise = (async () => {
    const name = deviceName || getDeviceName()
    const data = await kioskReq<{ device_token: string }>("/kiosk/register", "POST", {
      device_name: name,
    })
    const newToken = data.device_token ?? null
    if (newToken) {
      setDeviceToken(newToken)
      setDeviceName(name)
    }
    return newToken
  })().finally(() => { _registerPromise = null })

  return _registerPromise
}

// ---------------------------------------------------------------------------
// State polling
// ---------------------------------------------------------------------------

/** Poll the current claim/pairing state for this device. */
export async function fetchKioskState(): Promise<KioskState> {
  const token = getDeviceToken()
  if (!token) return UNPAIRED

  let row: {
    found?: boolean
    device_id?: string
    device_name?: string
    paired?: boolean
    pairing_code?: string
    household_id?: string
    household_name?: string
    setup_complete?: boolean
    language?: string
    timezone?: string
  }

  try {
    row = await kioskReq<typeof row>("/kiosk/state", "GET")
  } catch (err) {
    console.error("[kiosk] fetchKioskState failed:", err)
    return UNPAIRED
  }

  if (!row?.found) {
    clearDeviceToken()
    return UNPAIRED
  }

  return {
    found: true,
    deviceId: row.device_id ?? null,
    deviceName: row.device_name ?? "Kiosk Display",
    paired: !!row.paired,
    pairingCode: row.pairing_code ?? null,
    householdId: row.household_id ?? null,
    householdName: row.household_name ?? null,
    setupComplete: !!row.setup_complete,
    language: row.language ?? null,
    timezone: row.timezone ?? null,
  }
}

// ---------------------------------------------------------------------------
// Setup save
// ---------------------------------------------------------------------------

export async function saveSetup(input: {
  deviceName: string
  language: string
  timezone: string
}): Promise<boolean> {
  const token = getDeviceToken()
  if (!token) return false

  await kioskReq("/kiosk/setup", "POST", {
    device_name: input.deviceName,
    language: input.language,
    timezone: input.timezone,
  })

  setDeviceName(input.deviceName)
  return true
}

/** Tell the hub the wall's new time zone, so phones elsewhere convert to it. */
export async function saveTimezone(timezone: string): Promise<void> {
  if (!getDeviceToken()) return
  await kioskReq("/kiosk/setup", "POST", { timezone })
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export async function sendHeartbeat(metrics: {
  wifi: number
  ping: number
  battery?: number | null
  deviceInfo?: string | null
}): Promise<void> {
  try {
    await kioskReq("/kiosk/heartbeat", "POST", {
      wifi_signal: metrics.wifi,
      ping_latency_ms: metrics.ping,
      battery_percent: metrics.battery ?? null,
      device_info: metrics.deviceInfo ?? null,
    })
  } catch (err) {
    console.error("[kiosk] heartbeat failed:", err)
  }
}

// ---------------------------------------------------------------------------
// Unpairing
// ---------------------------------------------------------------------------

export async function unpairKiosk(): Promise<string | null> {
  try {
    const data = await kioskReq<{ pairing_code?: string }>("/kiosk/unpair", "POST")
    return data.pairing_code ?? null
  } catch (err) {
    console.error("[kiosk] unpairKiosk failed:", err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Hub info — unauthenticated probe used to decide first-time activation
// vs. QR pairing for an additional display.
// ---------------------------------------------------------------------------

export type HubInfo = { hubId: string; name: string; claimed: boolean }

/** GET /api/v1/hub/info — no device token required. Returns null on any failure. */
export async function fetchHubInfo(): Promise<HubInfo | null> {
  try {
    const res = await fetch(`${LOCAL_API_BASE}/api/v1/hub/info`)
    if (!res.ok) return null
    const data = (await res.json()) as { hub_id?: string; name?: string; claimed?: boolean }
    if (typeof data.claimed !== "boolean") return null
    return { hubId: data.hub_id ?? "", name: data.name ?? "", claimed: data.claimed }
  } catch {
    return null
  }
}

/** What a hub that isn't set up yet shows on its own screen (GET /api/v1/hub/setup). */
export type HubSetup = { setupCode: string; hubUrl: string | null; name: string }

/**
 * The setup code and LAN address, for the activation screen. The hub only
 * answers requests from itself, so this is null on a display running anywhere
 * else, or once the hub is set up.
 */
export async function fetchHubSetup(): Promise<HubSetup | null> {
  try {
    const res = await fetch(`${LOCAL_API_BASE}/api/v1/hub/setup`)
    if (!res.ok) return null
    return (await res.json()) as HubSetup
  } catch {
    return null
  }
}

/**
 * What the setup QR code holds: the hub's address and setup code, so a phone
 * can scan it instead of searching the network and typing the code.
 * Contract source: mobile/src/app/auth/find-hub-flow.tsx (parseSetupQr).
 */
export function setupQrPayload(setup: HubSetup): string {
  return JSON.stringify({ lumora: "setup", hub: setup.hubUrl, code: setup.setupCode })
}

/** What came across when this hub took over a household from an old one. */
export type MoveSummary = {
  householdName: string
  members: number
  events: number
  chores: number
  lists: number
  meals: number
  photos: number
  calendarsLinked: number
}

/**
 * Moves a household from an old hub onto this one (POST /api/v1/transfer/pull).
 * The hub only accepts this from its own screen, before setup. `from` is the
 * old hub's address, for when it can't be found on the network.
 */
export async function moveFromOldHub(code: string, from?: string): Promise<MoveSummary> {
  const res = await fetch(`${LOCAL_API_BASE}/api/v1/transfer/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, from: from || undefined }),
  })
  const data = (await res.json().catch(() => ({}))) as Partial<MoveSummary> & { error?: string }
  if (!res.ok) throw new Error(data.error ?? "The move didn't finish. Try again.")
  return data as MoveSummary
}

// ---------------------------------------------------------------------------
// Self-claim — used only by the first-time activation screen. Links THIS
// device to the household that was just created, using the caller's own
// Supabase access_token (not the device token) as the bearer, since
// POST /kiosk/claim is a user-authenticated endpoint. Reuses the existing,
// unmodified claim endpoint — no server changes required.
// ---------------------------------------------------------------------------

export async function claimThisDevice(accessToken: string, pairingCode: string): Promise<void> {
  const res = await fetch(`${LOCAL_API_BASE}/api/v1/kiosk/claim`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ pairing_code: pairingCode }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string }
    throw new Error(err.error ?? `HTTP ${res.status}`)
  }
}

// ---------------------------------------------------------------------------
// Pairing payload
// ---------------------------------------------------------------------------

// JSON, not a deep link. The phone reads .pairing_code in Settings › Displays
// (pair-kiosk-sheet.tsx); `lumora` and `hub` let its first-run scanner
// (find-hub-flow.tsx) recognise a display code and find the hub from it.
export function buildPairingPayload(pairingCode: string, hubUrl?: string): string {
  return JSON.stringify({ lumora: "display", hub: hubUrl ?? null, pairing_code: pairingCode })
}
