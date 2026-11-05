// ---------------------------------------------------------------------------
// What a wall display does for the Solora console (central/src/routes/fleet.ts):
//
//   provision:update    apply a provisioning profile, or ask the family first
//   device:report-logs  send the last hour of this display's log buffer
//
// Display settings go through the same hub-command handlers as the console's
// display controls (centralSocket.applyLocally), so a profile can never do
// more than those can. Update channel and quiet hours are central's side; the
// display only reports that the family accepted.
// ---------------------------------------------------------------------------

import { kioskToast } from "@/components/os/kiosk-toast"
import { centralSocket, type HubCommandEvent, type ProvisionPayload } from "./central-socket"
import { addLog, getLogs } from "./hub"
import { setLanguage, setTimezone } from "./locale-service"
import "./feature-flags"

function commandsFor(p: ProvisionPayload): HubCommandEvent[] {
  const d = p.settings.display ?? {}
  const out: HubCommandEvent[] = []
  if (d.orientation) out.push({ type: "set_orientation", orientation: d.orientation })
  if (d.idle_mins !== undefined) out.push({ type: "set_idle_mins", minutes: d.idle_mins })
  if (d.brightness !== undefined) out.push({ type: "set_brightness", level: d.brightness })
  if (d.volume !== undefined) out.push({ type: "set_volume", level: d.volume })
  if (d.theme) out.push({ type: "set_theme", theme: d.theme })
  if (d.season_effects !== undefined) out.push({ type: "set_season_effects", on: d.season_effects })
  return out
}

/** Plain words for what a profile changes, shown on the prompt. */
function describe(p: ProvisionPayload): string {
  const s = p.settings
  const parts: string[] = []
  const d = s.display ?? {}
  if (d.brightness !== undefined) parts.push(`brightness ${d.brightness}%`)
  if (d.volume !== undefined) parts.push(`volume ${d.volume}%`)
  if (d.theme) parts.push(`${d.theme} theme`)
  if (d.orientation) parts.push(`${d.orientation} orientation`)
  if (d.idle_mins !== undefined) parts.push(d.idle_mins === null ? "no slideshow" : `slideshow after ${d.idle_mins} min`)
  if (d.season_effects !== undefined) parts.push(`season effects ${d.season_effects ? "on" : "off"}`)
  if (s.install_window) parts.push(`updates ${s.install_window.start}–${s.install_window.end}`)
  if (s.update_channel) parts.push(`${s.update_channel === "internal" ? "dev" : s.update_channel} updates`)
  if (s.timezone) parts.push(s.timezone)
  return parts.join(", ")
}

async function apply(p: ProvisionPayload) {
  try {
    for (const cmd of commandsFor(p)) centralSocket.applyLocally(cmd)
    if (p.settings.timezone) await setTimezone(p.settings.timezone)
    if (p.settings.locale) await setLanguage(p.settings.locale)
    addLog("success", "system", `Applied Solora settings “${p.name}” (r${p.revision})`)
    centralSocket.emitProvisionResult(p, "applied")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    addLog("error", "system", `Couldn't apply “${p.name}”: ${message}`)
    centralSocket.emitProvisionResult(p, "failed", message.slice(0, 500))
  }
}

function onProvision(p: ProvisionPayload) {
  if (p.mode === "apply") {
    void apply(p)
    kioskToast.info("Solora updated this display's settings", { description: p.settings.message ?? describe(p) })
    return
  }
  centralSocket.emitProvisionResult(p, "prompted")
  kioskToast.notice(p.settings.message ?? "New settings from Solora", {
    id: `provision-${p.profile_id}`,
    description: describe(p) || "Nothing visible changes on this display.",
    duration: 5 * 60_000,
    action: { label: "Apply", onClick: () => void apply(p) },
  })
}

const LEVEL = { info: "info", success: "info", warning: "warn", error: "error" } as const

function onReportLogs(sinceMinutes: number) {
  const since = Date.now() - sinceMinutes * 60_000
  const recent = getLogs().filter((l) => new Date(l.time).getTime() >= since).slice(-200)
  for (const l of recent) centralSocket.emitLog(LEVEL[l.level], `[${l.source}] ${l.message}`.slice(0, 4000))
  addLog("info", "system", `Sent ${recent.length} log lines to Solora Support`)
}

let started = false

/** Call once from the app shell. */
export function startFleetControl(): () => void {
  if (started) return () => {}
  started = true
  const offProvision = centralSocket.onProvision(onProvision)
  const offLogs = centralSocket.onReportLogs(onReportLogs)
  return () => { offProvision(); offLogs(); started = false }
}
