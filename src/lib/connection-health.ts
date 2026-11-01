// ---------------------------------------------------------------------------
// connection-health.ts — diagnose the full registration chain
//
// Call checkConnectionHealth() to get a snapshot of every required connection.
// Useful after a factory reset to see exactly which step failed.
// ---------------------------------------------------------------------------

import { tokenStore } from "./local-api"
import { getLocalDeviceId } from "./kiosk-session"
import { getCentralToken, centralSocket } from "./central-socket"

const LOCAL_API_BASE =
  (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:4000"

const CENTRAL_SOCKET_URL =
  (import.meta.env.VITE_CENTRAL_SOCKET_URL as string | undefined) ??
  "http://localhost:5001"

const CENTRAL_API_URL =
  (import.meta.env.VITE_CENTRAL_API_URL as string | undefined) ??
  "http://localhost:4000"

export interface ConnectionHealth {
  ts: string

  kiosk: {
    has_device_token:   boolean   // kiosk registered with local hub
    has_central_token:  boolean   // kiosk registered with central API
    central_connected:  boolean   // central socket.io connected right now
  }

  local_hub: {
    url:        string
    reachable:  boolean
    registered_with_central: boolean | null    // null = couldn't fetch
    hub_id:     string | null
    central_socket_connected: boolean | null
    this_kiosk_registered:    boolean | null
  }

  central_api: {
    url:      string
    reachable: boolean
    error?:   string
  }

  central_socket: {
    url:      string
    reachable: boolean
    error?:   string
  }

  next_steps: string[]
}

export async function checkConnectionHealth(): Promise<ConnectionHealth> {
  const deviceToken  = tokenStore.get()
  const centralToken = getCentralToken()

  // ── Ping local hub health ─────────────────────────────────────────────────
  const hubHealth = await (async () => {
    try {
      const r = await fetch(`${LOCAL_API_BASE}/connection-health`, {
        signal: AbortSignal.timeout(4000),
      })
      if (!r.ok) return { reachable: true, data: null }
      return { reachable: true, data: await r.json() as Record<string, unknown> }
    } catch (e) {
      return { reachable: false, error: (e as Error).message, data: null }
    }
  })()

  // ── Ping central API ──────────────────────────────────────────────────────
  const centralApiPing = await (async () => {
    try {
      const r = await fetch(`${CENTRAL_API_URL}/health`, { signal: AbortSignal.timeout(3000) })
      return { reachable: r.ok }
    } catch (e) {
      return { reachable: false, error: (e as Error).message }
    }
  })()

  // ── Ping central socket ───────────────────────────────────────────────────
  const centralSocketPing = await (async () => {
    try {
      const r = await fetch(`${CENTRAL_SOCKET_URL}/health`, { signal: AbortSignal.timeout(3000) })
      return { reachable: r.ok }
    } catch (e) {
      return { reachable: false, error: (e as Error).message }
    }
  })()

  // ── Derive per-kiosk registration status from hub health response ─────────
  const localDeviceId = getLocalDeviceId()
  const hubData = hubHealth.data as {
    hub?: { registered_with_central: boolean; hub_id: string | null; central_socket_connected: boolean }
    kiosks?: Array<{ local_device_id: string; central_registered: boolean }>
  } | null

  const kioskCentralRegistered = localDeviceId && hubData?.kiosks
    ? (hubData.kiosks.find(k => k.local_device_id === localDeviceId)?.central_registered ?? null)
    : null

  // ── Build next_steps list ─────────────────────────────────────────────────
  const steps: string[] = []

  if (!hubHealth.reachable) {
    steps.push(`Local hub unreachable at ${LOCAL_API_BASE} — check hub server is running and VITE_SERVER_URL is correct`)
  }
  if (hubHealth.reachable && !deviceToken) {
    steps.push("No device token — kiosk needs to register with local hub (POST /api/v1/kiosk/register). This happens automatically on first launch.")
  }
  if (!centralApiPing.reachable) {
    steps.push(`Central API unreachable at ${CENTRAL_API_URL} — check CENTRAL_API_URL in server/.env and VITE_CENTRAL_API_URL in kiosk .env`)
  }
  if (!centralSocketPing.reachable) {
    steps.push(`Central socket unreachable at ${CENTRAL_SOCKET_URL} — check CENTRAL_SOCKET_URL in server/.env and VITE_CENTRAL_SOCKET_URL in kiosk .env`)
  }
  if (hubData && !hubData.hub?.registered_with_central) {
    steps.push("Hub not registered with central API — check CENTRAL_API_URL in hub server .env, then restart hub server")
  }
  if (!centralToken) {
    steps.push("No central token on kiosk — hub must register this kiosk (happens after hub registers itself). Try restarting the hub server, then reload this kiosk.")
  }
  if (!centralSocket.connected) {
    steps.push("Central socket not connected — this display needs a central token first (see above)")
  }

  return {
    ts: new Date().toISOString(),

    kiosk: {
      has_device_token:  !!deviceToken,
      has_central_token: !!centralToken,
      central_connected: centralSocket.connected,
    },

    local_hub: {
      url:       LOCAL_API_BASE,
      reachable: hubHealth.reachable,
      registered_with_central:  hubData?.hub?.registered_with_central ?? null,
      hub_id:                   hubData?.hub?.hub_id ?? null,
      central_socket_connected: hubData?.hub?.central_socket_connected ?? null,
      this_kiosk_registered:    kioskCentralRegistered,
    },

    central_api: {
      url:       CENTRAL_API_URL,
      reachable: centralApiPing.reachable,
      ...(centralApiPing.error ? { error: centralApiPing.error } : {}),
    },

    central_socket: {
      url:       CENTRAL_SOCKET_URL,
      reachable: centralSocketPing.reachable,
      ...(centralSocketPing.error ? { error: centralSocketPing.error } : {}),
    },

    next_steps: steps,
  }
}

/** Log a health snapshot to the console — call this on startup or on demand. */
export async function logConnectionHealth(): Promise<void> {
  const h = await checkConnectionHealth()
  const ok = (v: boolean | null) => v === true ? "✓" : v === false ? "✗" : "?"
  console.group("[connection-health]", new Date(h.ts).toLocaleTimeString())
  console.log(`Local hub      ${ok(h.local_hub.reachable)}  ${h.local_hub.url}`)
  console.log(`Central API    ${ok(h.central_api.reachable)}  ${h.central_api.url}`)
  console.log(`Central socket ${ok(h.central_socket.reachable)}  ${h.central_socket.url}`)
  console.log(`Device token   ${ok(h.kiosk.has_device_token)}`)
  console.log(`Central token  ${ok(h.kiosk.has_central_token)}`)
  console.log(`Socket live    ${ok(h.kiosk.central_connected)}`)
  console.log(`Hub registered ${ok(h.local_hub.registered_with_central)}  hub_id=${h.local_hub.hub_id ?? "none"}`)
  console.log(`This kiosk →   ${ok(h.local_hub.this_kiosk_registered)}`)
  if (h.next_steps.length) {
    console.warn("Next steps:")
    h.next_steps.forEach(s => console.warn(" →", s))
  } else {
    console.log("All connections healthy ✓")
  }
  console.groupEnd()
}
