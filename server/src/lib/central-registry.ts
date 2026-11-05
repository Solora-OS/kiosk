/**
 * central-registry.ts — registers this hub with the central API on startup.
 *
 * On first boot: POST /register/hub → hub_id + hub_token (persisted forever).
 * On subsequent boots: POST /register/hub/login → fresh short-lived JWT.
 * For each paired kiosk: POST /register/kiosk → device JWT stored per device.
 *
 * All credentials are persisted to $HOME/.solora/central.json so they survive
 * restarts without re-registering. They register afresh when they came from
 * another central or central answers 401 (it doesn't know this hub); a revoked
 * hub gets 403 and stays as it is.
 */

import fs from "fs"
import path from "path"
import { DATA_DIR, getDb } from "../db"

const CENTRAL_API_URL   = process.env.CENTRAL_API_URL   ?? "http://localhost:4000"
const HUB_NAME          = process.env.HUB_NAME          ?? "Solora Hub"
const HUB_OWNER_EMAIL   = process.env.HUB_OWNER_EMAIL   ?? "admin@solora.local"
const CREDENTIALS_PATH  = path.join(DATA_DIR, "central.json")

// ---------------------------------------------------------------------------
// Persisted credentials shape
// ---------------------------------------------------------------------------

interface CentralCredentials {
  hub_id:    string
  hub_token: string         // long-lived secret — never expires
  hub_jwt:   string         // short-lived JWT — refreshed on every boot
  kiosks: Record<string, { central_device_id: string; central_jwt: string }>
  /** The central these were issued by; files from before this was kept have none. */
  central_url?: string
}

function loadCredentials(): CentralCredentials | null {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, "utf-8")
    return JSON.parse(raw) as CentralCredentials
  } catch {
    return null
  }
}

function saveCredentials(creds: CentralCredentials): void {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(creds, null, 2), "utf-8")
}

let _credentials: CentralCredentials | null = null

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Returns the hub's central API JWT (refreshed on startup). */
export function getHubJwt(): string | null {
  return _credentials?.hub_jwt ?? null
}

/** Returns the central socket JWT for a local kiosk device id. */
export function getCentralKioskToken(localDeviceId: string): string | null {
  return _credentials?.kiosks?.[localDeviceId]?.central_jwt ?? null
}

/** Returns both the central device UUID and JWT for a local kiosk device id. */
export function getCentralKioskCredentials(localDeviceId: string): { central_device_id: string; central_jwt: string } | null {
  return _credentials?.kiosks?.[localDeviceId] ?? null
}

/**
 * Drops the stored central login of the kiosk central knows as
 * `centralDeviceId` (after Solora unpaired it). The kiosk stays paired to this
 * hub locally; it gets a fresh central identity the next time it asks
 * (POST /api/v1/kiosk/request-central-token). Returns the local kiosk id.
 */
export function forgetCentralDevice(centralDeviceId: string): string | null {
  if (!_credentials) return null
  const entry = Object.entries(_credentials.kiosks ?? {}).find(([, k]) => k.central_device_id === centralDeviceId)
  if (!entry) return null
  delete _credentials.kiosks[entry[0]]
  saveCredentials(_credentials)
  return entry[0]
}

/**
 * Registers this hub (and all paired kiosks) with the central API.
 * Safe to call on every boot — re-uses stored credentials if already registered.
 *
 * @returns hub JWT to use for central socket connection, or null on failure
 */
export async function ensureCentralRegistration(): Promise<string | null> {
  let creds = loadCredentials()
  if (creds?.central_url && creds.central_url !== CENTRAL_API_URL) {
    console.log(`[central] Stored hub credentials are for ${creds.central_url}; registering with ${CENTRAL_API_URL}`)
    creds = null
  }

  let hubId:    string | undefined
  let hubToken: string | undefined
  let hubJwt:   string | undefined

  if (creds) {
    // Already registered — just refresh the JWT
    try {
      const res  = await fetch(`${CENTRAL_API_URL}/register/hub/login`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ hub_id: creds.hub_id, hub_token: creds.hub_token }),
        signal:  AbortSignal.timeout(5000),
      })
      if (res.status === 401) {
        console.log(`[central] Central doesn't know hub_id=${creds.hub_id}; registering again`)
        creds = null
      } else {
        if (!res.ok) throw new Error(`Hub login failed: ${res.status}`)
        const data = (await res.json()) as { jwt: string }
        hubId    = creds.hub_id
        hubToken = creds.hub_token
        hubJwt   = data.jwt
        console.log(`[central] Hub refreshed JWT  hub_id=${hubId}`)
      }
    } catch (e) {
      console.warn("[central] Could not refresh hub JWT — using cached:", (e as Error).message)
      // Use cached JWT (may be expired but central socket will reject and we'll retry)
      _credentials = creds
      return creds!.hub_jwt
    }
  }
  if (!hubId || !hubToken || !hubJwt) {
    // First registration
    try {
      const res  = await fetch(`${CENTRAL_API_URL}/register/hub`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name: HUB_NAME, owner_email: HUB_OWNER_EMAIL }),
        signal:  AbortSignal.timeout(5000),
      })
      if (!res.ok) throw new Error(`Hub registration failed: ${res.status}`)
      const data = (await res.json()) as { hub_id: string; hub_token: string; jwt: string }
      hubId    = data.hub_id
      hubToken = data.hub_token
      hubJwt   = data.jwt
      console.log(`[central] Hub registered  hub_id=${hubId}`)
    } catch (e) {
      console.warn("[central] Could not register with central API — running offline:", (e as Error).message)
      return null
    }
  }

  // Update in-memory + persisted credentials. Display logins from an earlier
  // registration belong to that hub, so a fresh registration starts without them.
  const updated: CentralCredentials = {
    hub_id:      hubId,
    hub_token:   hubToken,
    hub_jwt:     hubJwt,
    kiosks:      creds?.kiosks ?? {},
    central_url: CENTRAL_API_URL,
  }
  saveCredentials(updated)
  _credentials = updated

  // Register any paired kiosks not yet registered with central
  await _registerPairedKiosks(hubJwt, updated)

  return hubJwt
}

// ---------------------------------------------------------------------------
// Kiosk registration
// ---------------------------------------------------------------------------

/**
 * Registers a single kiosk with the central API on demand.
 * Called when a kiosk hits POST /kiosk/request-central-token and the hub
 * missed it during startup (e.g. env vars were wrong, kiosk wasn't paired yet).
 *
 * @returns the central JWT for the kiosk, or null on failure
 */
export async function registerKioskWithCentral(localDeviceId: string): Promise<string | null> {
  if (!_credentials) {
    console.warn("[central] Cannot register kiosk — hub not registered with central API yet")
    return null
  }

  // Already registered
  const existing = _credentials.kiosks[localDeviceId]?.central_jwt
  if (existing) return existing

  const db = getDb()
  const row = db.prepare("SELECT id, device_name FROM kiosk_devices WHERE id = ?").get(localDeviceId) as
    | { id: string; device_name: string }
    | undefined

  if (!row) {
    console.warn(`[central] registerKioskWithCentral: device ${localDeviceId} not found in DB`)
    return null
  }

  try {
    const res = await fetch(`${CENTRAL_API_URL}/register/kiosk`, {
      method:  "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${_credentials.hub_jwt}`,
      },
      body: JSON.stringify({ device_name: row.device_name }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) {
      console.warn(`[central] On-demand kiosk registration failed  device=${localDeviceId}  status=${res.status}`)
      return null
    }
    const data = (await res.json()) as { device_id: string; jwt: string }
    _credentials.kiosks[localDeviceId] = { central_device_id: data.device_id, central_jwt: data.jwt }
    saveCredentials(_credentials)
    console.log(`[central] Kiosk registered on-demand  local=${localDeviceId}  central=${data.device_id}`)
    return data.jwt
  } catch (e) {
    console.warn(`[central] On-demand kiosk registration error:`, (e as Error).message)
    return null
  }
}

async function _registerPairedKiosks(
  hubJwt:  string,
  creds:   CentralCredentials,
): Promise<void> {
  const db = getDb()
  const pairedKiosks = db.prepare(
    "SELECT id, device_name FROM kiosk_devices WHERE household_id IS NOT NULL",
  ).all() as Array<{ id: string; device_name: string }>

  for (const kiosk of pairedKiosks) {
    if (creds.kiosks[kiosk.id]) continue // already registered

    try {
      const res = await fetch(`${CENTRAL_API_URL}/register/kiosk`, {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${hubJwt}`,
        },
        body: JSON.stringify({ device_name: kiosk.device_name }),
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        console.warn(`[central] Kiosk registration failed  device=${kiosk.id}  status=${res.status}`)
        continue
      }
      const data = (await res.json()) as { device_id: string; jwt: string }
      creds.kiosks[kiosk.id] = { central_device_id: data.device_id, central_jwt: data.jwt }
      console.log(`[central] Kiosk registered  local=${kiosk.id}  central=${data.device_id}`)
    } catch (e) {
      console.warn(`[central] Could not register kiosk  device=${kiosk.id}:`, (e as Error).message)
    }
  }

  // Persist after all kiosk registrations
  saveCredentials(creds)
}
