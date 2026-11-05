// ---------------------------------------------------------------------------
// Feature flags from the console (central `flags:update` and GET /devices/config).
//
// Central works out the effective set for this display's hub (fleet setting,
// rollout percentage, the hub's provisioning profile), so the app just reads
// it. Kept in localStorage so a flag holds across restarts and offline boots.
//
//   if (isFeatureOn("kiosk.new_home")) …
//   const on = useFeatureFlag("kiosk.new_home")
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react"
import { centralSocket } from "./central-socket"

const KEY = "solora.feature-flags"
const listeners = new Set<() => void>()

function load(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, boolean> } catch { return {} }
}

let flags = load()

centralSocket.onFlags((next) => {
  flags = next
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* ignore */ }
  for (const l of listeners) l()
})

/** A flag central doesn't know about is off. */
export function isFeatureOn(key: string, fallback = false): boolean {
  return key in flags ? flags[key] : fallback
}

export function useFeatureFlag(key: string, fallback = false): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
    () => isFeatureOn(key, fallback),
  )
}
