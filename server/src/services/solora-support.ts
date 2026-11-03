/**
 * solora-support.ts — what Solora (the manufacturer) does to this hub, told to
 * the family, and the household's side of support access.
 *
 *   - Every action Solora takes on this hub or its displays arrives from central
 *     (live as `manufacturer:action`, or caught up via GET /household/actions
 *     after the hub was offline) and is written to the household's activity log
 *     as `solora.<action>`, deduplicated by central's audit id.
 *   - A support access request (`support:request`) notifies the household's admins.
 *
 * Contract source: central/src/routes/household.ts.
 */

import { getDb } from "../db"
import { writeLog } from "../routes/activity-logs"
import { notifyMembers } from "./notify"
import { getCentralKioskCredentials } from "../lib/central-registry"

const CENTRAL_API_URL = process.env.CENTRAL_API_URL ?? "http://localhost:4000"

export interface SoloraAction {
  id:          number
  at:          string
  action:      string
  reason:      string | null
  target_type: string | null
  target_id:   string | null
  approved:    boolean
}

export interface HouseholdGrant {
  id:             string
  duration_hours: number
  reason:         string
  status:         "requested" | "granted" | "denied" | "revoked" | "expired"
  expires_at:     string | null
}

export class CentralUnavailableError extends Error {}

let hubJwt: string | null = null

/** Set by central-socket-client.ts once the hub has a central JWT. */
export function setSupportHubJwt(jwt: string): void {
  hubJwt = jwt
}

/** Calls central as this hub. Throws CentralUnavailableError when it can't. */
export async function centralFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  if (!hubJwt) throw new CentralUnavailableError("This hub isn't connected to Solora's service yet.")
  let res: globalThis.Response
  try {
    res = await fetch(`${CENTRAL_API_URL}${path}`, {
      method:  init.method ?? "GET",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hubJwt}` },
      body:    init.body === undefined ? undefined : JSON.stringify(init.body),
      signal:  AbortSignal.timeout(8000),
    })
  } catch {
    throw new CentralUnavailableError("Solora's service can't be reached right now.")
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string }) | null
  if (!res.ok) {
    const err = new Error(json?.error ?? `Solora's service answered ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }
  return json as T
}

function householdId(): string | null {
  const row = getDb().prepare("SELECT id FROM households ORDER BY created_at LIMIT 1").get() as { id: string } | undefined
  return row?.id ?? null
}

/** A display's name from its central device id (phones aren't known by id here). */
function deviceName(centralId: string | null): string {
  if (!centralId) return ""
  const rows = getDb().prepare("SELECT id, device_name FROM kiosk_devices").all() as { id: string; device_name: string }[]
  return rows.find((r) => getCentralKioskCredentials(r.id)?.central_device_id === centralId)?.device_name ?? ""
}

/** One line a family member can read. */
export function describeSoloraAction(action: string, name: string): string {
  const it = name || "a device"
  switch (action) {
    case "device.reboot":        return `Restarted ${it}`
    case "device.report_status": return `Checked on ${it}`
    case "device.lock":          return `Changed the lock on ${it}`
    case "device.revoke":        return `Disconnected ${it} from Solora's service`
    case "device.logs":          return `Read ${it}'s diagnostic logs, with your permission`
    case "hub.command":          return "Sent a command to your wall displays"
    case "hub.revoke":           return "Disconnected your hub from Solora's service"
    case "ota.push":             return "Sent a software update"
    case "ota.cancel":           return "Cancelled a software update"
    case "notice.send":          return "Sent a service notice"
    case "support.request":      return "Asked for access to diagnostics"
    case "support.expired":      return "Support access ended"
    default:                     return `Solora: ${action}`
  }
}

export function recordSoloraAction(a: SoloraAction): void {
  const hh = householdId()
  if (!hh) return
  const db = getDb()
  const seen = db.prepare(
    "SELECT 1 FROM activity_logs WHERE household_id = ? AND action LIKE 'solora.%' AND json_extract(metadata, '$.central_id') = ?",
  ).get(hh, a.id)
  if (seen) return
  const name = a.target_type === "device" ? deviceName(a.target_id) : ""
  writeLog({
    householdId:  hh,
    actorName:    "Solora",
    action:       `solora.${a.action}`,
    resourceType: a.target_type ?? "hub",
    resourceId:   a.target_id,
    resourceName: name,
    metadata:     { central_id: a.id, at: a.at, reason: a.reason, approved: a.approved, summary: describeSoloraAction(a.action, name) },
  })
}

/** Fetches anything Solora did while this hub was offline. */
export async function syncSoloraActions(): Promise<number> {
  const hh = householdId()
  if (!hh) return 0
  const row = getDb().prepare(
    "SELECT max(CAST(json_extract(metadata, '$.central_id') AS INTEGER)) AS last FROM activity_logs WHERE household_id = ? AND action LIKE 'solora.%'",
  ).get(hh) as { last: number | null }
  const { actions } = await centralFetch<{ actions: SoloraAction[] }>(`/household/actions?after_id=${row.last ?? 0}`)
  for (const a of actions) recordSoloraAction(a)
  return actions.length
}

export function onSupportRequest(grant: HouseholdGrant): void {
  const hh = householdId()
  if (!hh) return
  const admins = (getDb().prepare("SELECT id FROM members WHERE household_id = ? AND role = 'admin'").all(hh) as { id: string }[]).map((m) => m.id)
  if (admins.length === 0) return
  notifyMembers(hh, admins, {
    title: "Solora Support is asking for access",
    body:  `${grant.reason} Open Settings › Privacy & support to allow or deny.`,
    ref:   "support",
  })
}
