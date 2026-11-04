/**
 * mdns-advertise.ts — publishes this hub as _lumora._tcp on the LAN so the
 * mobile app can discover it without knowing its IP.
 *
 * TXT records: hub_id (local identity, see hub-identity.ts), name, claimed.
 * "claimed" is derived live from the households table (same pattern as
 * kiosk_devices.household_id IS NOT NULL elsewhere) — no schema column.
 */

import { Bonjour, type Service } from "bonjour-service"
import { getDb } from "../db"
import { getOrCreateHubIdentity } from "./hub-identity"

const SERVICE_TYPE = "lumora" // advertises as _lumora._tcp.local

let _bonjour: Bonjour | null = null
let _service: Service | null = null
let _refreshTimer: ReturnType<typeof setInterval> | null = null

function isClaimed(): boolean {
  const db = getDb()
  const row = db.prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  return row.n > 0
}

function publish(port: number): void {
  const identity = getOrCreateHubIdentity()
  _service = _bonjour!.publish({
    name: identity.name,
    type: SERVICE_TYPE,
    port,
    txt: {
      hub_id: identity.id,
      name: identity.name,
      claimed: isClaimed() ? "1" : "0",
    },
  })
}

/** Publishes the _lumora._tcp Bonjour service. Call once the HTTP server is listening. */
export function startMdnsAdvertisement(port: number): void {
  // Test hubs (tests/contract) mustn't show up on real phones on the LAN.
  if (process.env.SOLORA_MDNS === "off") return
  _bonjour = new Bonjour()
  publish(port)

  const identity = getOrCreateHubIdentity()
  console.log(`[mdns] Advertising _${SERVICE_TYPE}._tcp as "${identity.name}" (hub_id=${identity.id})`)

  // TXT records are static once published — households can go from 0 → 1
  // rows during POST /auth/session, so poll and re-publish on change. A
  // short staleness window (<=30s) is harmless: GET /hub/info is the real
  // source of truth once the app taps a discovered hub.
  _refreshTimer = setInterval(() => {
    if (!_service) return
    const claimedNow = isClaimed() ? "1" : "0"
    if (_service.txt?.claimed === claimedNow) return
    const port = _service.port
    _service.stop(() => publish(port))
  }, 30_000)
}

export function stopMdnsAdvertisement(): void {
  if (_refreshTimer) clearInterval(_refreshTimer)
  _bonjour?.unpublishAll(() => _bonjour?.destroy())
}
