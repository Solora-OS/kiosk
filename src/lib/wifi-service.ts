"use client"

/**
 * WiFi service abstraction.
 *
 * The Lumora setup wizard shows a fully custom WiFi UI — users never see the
 * Ubuntu / NetworkManager system dialogs. The actual network management runs in
 * the Tauri Rust backend (see `wifi_scan` / `wifi_connect` / `wifi_status` in
 * `src-tauri/src/lib.rs`), which will talk to NetworkManager on Linux.
 *
 * This module is the single boundary the UI uses. It only ever returns the
 * real list reported by NetworkManager — when scanning isn't possible (no
 * Tauri shell, nmcli missing, scan refused) it throws, so the UI shows an
 * honest error instead of a made-up list.
 *
 * For designing the wizard in a plain browser, set VITE_WIFI_MOCK=1 to opt
 * into a clearly fake list.
 */

export type WifiSecurity = "open" | "wpa" | "wep"

export type WifiNetwork = {
  ssid: string
  /** Signal strength as a percentage (0-100). */
  signal: number
  security: WifiSecurity
  /** Whether the kiosk is currently connected to this network. */
  connected: boolean
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import("@tauri-apps/api/core")
  return mod.invoke<T>(cmd, args)
}

// Opt-in mock list for browser-only UI work (VITE_WIFI_MOCK=1). Never used
// otherwise, so a real device can't silently show fake networks.
const USE_MOCK = !isTauri() && import.meta.env.VITE_WIFI_MOCK === "1"

const MOCK_NETWORKS: WifiNetwork[] = [
  { ssid: "Mock Network (dev)", signal: 92, security: "wpa", connected: false },
  { ssid: "Mock Open Network (dev)", signal: 51, security: "open", connected: false },
]

let _connectedSsid: string | null = null

const UNAVAILABLE = "Wi-Fi scanning is only available on the hub itself."

function errorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err) return err
  if (err instanceof Error && err.message) return err.message
  return fallback
}

/** Scan for nearby WiFi networks, sorted strongest-first. Throws when scanning isn't possible. */
export async function scanNetworks(): Promise<WifiNetwork[]> {
  if (isTauri()) {
    try {
      const nets = await invoke<WifiNetwork[]>("wifi_scan")
      return [...nets].sort((a, b) => b.signal - a.signal)
    } catch (err) {
      console.error("[wifi-service] scan failed:", err)
      throw new Error(errorMessage(err, "Couldn't scan for networks."))
    }
  }
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 900))
    return MOCK_NETWORKS.map((n) => ({ ...n, connected: n.ssid === _connectedSsid }))
  }
  throw new Error(UNAVAILABLE)
}

/**
 * Connect to a network. Returns true on success; throws with a user-facing
 * message on failure.
 */
export async function connect(ssid: string, password?: string): Promise<boolean> {
  if (isTauri()) {
    try {
      return await invoke<boolean>("wifi_connect", { ssid, password: password ?? null })
    } catch (err) {
      throw new Error(errorMessage(err, "Couldn't connect to this network."))
    }
  }
  if (USE_MOCK) {
    await new Promise((r) => setTimeout(r, 1200))
    _connectedSsid = ssid
    return true
  }
  throw new Error(UNAVAILABLE)
}

/** Return the SSID of the currently connected network, if any. */
export async function currentNetwork(): Promise<string | null> {
  if (isTauri()) {
    try {
      return await invoke<string | null>("wifi_status")
    } catch {
      return null
    }
  }
  return USE_MOCK ? _connectedSsid : null
}

/** Whether a security type requires a password. */
export function needsPassword(security: WifiSecurity): boolean {
  return security !== "open"
}
