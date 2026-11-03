import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { centralSocket, getCentralToken } from './central-socket';

/**
 * Hub (kiosk device) actions and activity log.
 *
 * The kiosk runs Android OS inside a Tauri v2 webview. When the native
 * runtime is present we use Tauri APIs (process relaunch / exit, etc.);
 * otherwise we fall back to browser-safe behavior so the preview still works.
 */

export type HubLogLevel = "info" | "success" | "warning" | "error"

export type HubLogEntry = {
  id: string
  time: string // ISO timestamp
  level: HubLogLevel
  source: string
  message: string
}

/** True when running inside the Tauri runtime (native webview). */
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
}

// ---- Update info ----------------------------------------------------------

export type UpdateInfo = {
  /** New version string, e.g. "0.2.0" */
  version: string
  /** ISO date string from the release manifest */
  date: string | null
  /** Markdown release notes / body */
  body: string | null
  /** SHA-256 digest of the update bundle (populated if available in manifest) */
  sha256: string | null
  /** Whether the update bundle was cryptographically signed */
  signed: boolean
  /** The raw Tauri Update object so we can call .downloadAndInstall() */
  _raw: Update | null
  /** ota_push_jobs id, when this update was triggered by a central OTA push — used to report completion back */
  jobId?: string
}

let pendingUpdate: UpdateInfo | null = null
const updateListeners = new Set<() => void>()

function emitUpdate() {
  for (const l of updateListeners) l()
}

/** Subscribe to update-availability changes. */
export function subscribeUpdate(cb: () => void): () => void {
  updateListeners.add(cb)
  return () => updateListeners.delete(cb)
}

/** Read the current pending update (null = none available / not checked yet). */
export function getPendingUpdate(): UpdateInfo | null {
  return pendingUpdate
}

/** Clear the pending update (e.g. after user dismisses). */
export function dismissUpdate(): void {
  pendingUpdate = null
  emitUpdate()
}

/** Download and install the pending update, then relaunch. */
export async function installUpdate(): Promise<void> {
  if (!pendingUpdate?._raw) return
  const { version, jobId } = pendingUpdate
  addLog("info", "updates", `Installing update to v${version}…`)
  try {
    await pendingUpdate._raw.downloadAndInstall((event) => {
      if (event.event === "Progress") {
        centralSocket.emitOtaProgress(event.data.chunkLength, "downloading")
      }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addLog("error", "updates", `Update to v${version} failed: ${message}`)
    void centralSocket.reportOtaResult(jobId, false, version, message)
    throw error
  }
  // The process relaunches immediately after this, so report success just before —
  // there's no later point at which we could still call back.
  void centralSocket.reportOtaResult(jobId, true, version)
  await relaunch()
}

export function isHubDevice(): boolean {
  return isTauri()
}

// ---- Activity log (in-memory, newest first) -------------------------------

let logs: HubLogEntry[] = seedLogs()
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export function subscribeLogs(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function getLogs(): HubLogEntry[] {
  return logs
}

export function addLog(level: HubLogLevel, source: string, message: string) {
  const entry: HubLogEntry = {
    id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    time: new Date().toISOString(),
    level,
    source,
    message,
  }
  logs = [entry, ...logs].slice(0, 200)
  emit()
  if (level === "warning" || level === "error") sendToCentral(level, source, message)
}

// Warnings and errors also go to central as device logs, so Solora Support
// can read them once the family grants access (and only then). These are the
// display's own system messages, never household content. Capped at 20 a
// minute so a failure loop can't flood central.
let sentThisMinute = 0
let minuteStart = 0
function sendToCentral(level: "warning" | "error", source: string, message: string) {
  const now = Date.now()
  if (now - minuteStart > 60_000) { minuteStart = now; sentThisMinute = 0 }
  if (++sentThisMinute > 20) return
  centralSocket.emitLog(level === "warning" ? "warn" : "error", `[${source}] ${message}`.slice(0, 4000))
}

export function clearLogs() {
  logs = []
  emit()
}

function seedLogs(): HubLogEntry[] {
  const now = Date.now()
  const min = 60_000
  const mk = (
    offset: number,
    level: HubLogLevel,
    source: string,
    message: string,
  ): HubLogEntry => ({
    id: `seed-${offset}`,
    time: new Date(now - offset).toISOString(),
    level,
    source,
    message,
  })
  return [
    mk(2 * min, "info", "sync", "Calendar synced — 9 events up to date"),
    mk(11 * min, "success", "auth", "Sarah signed in from Kitchen Hub"),
    mk(46 * min, "warning", "network", "Wi-Fi signal dropped to fair, recovered"),
    mk(96 * min, "info", "system", "Nightly screen dimming activated"),
    mk(184 * min, "success", "updates", "Updated to v1.0.0"),
    mk(320 * min, "info", "push", "Delivered 3 notifications"),
    mk(742 * min, "info", "system", "Hub restarted (scheduled maintenance)"),
  ]
}

// ---- Device actions -------------------------------------------------------

/** Relaunch the whole app/kiosk. */
export async function restartHub(): Promise<void> {
  addLog("warning", "system", "Restart requested")
  if (isTauri()) {
    try {
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
      return
    } catch {
      // fall through to reload
    }
  }
  window.location.reload()
}

/** Reload just the display/UI without restarting the process. */
export function reloadDisplay(): void {
  addLog("info", "system", "Display reloaded")
  window.location.reload()
}




/**
 * Check for OTA updates via the Tauri updater plugin.
 *
 * If an update is available the result is stored in `pendingUpdate` and all
 * `subscribeUpdate` listeners are notified so the UI can react in real-time.
 * Returns `true` when an update is available, `false` when up-to-date.
 *
 * @param jobId  ota_push_jobs id, when this check was triggered by a central OTA
 *   push (see `onOtaPush` in kiosk-app-shell.tsx). Used to report the outcome back
 *   to the central API so the job doesn't sit stuck at "acknowledged" forever.
 */
export async function checkForUpdates(jobId?: string): Promise<boolean> {
  try {
    // Central answers the updater (central/src/routes/releases.ts). The device
    // token tells it which hub this is, so it can hold back releases still
    // rolling out to other rings; without one, only fully released versions come.
    const token = getCentralToken()
    const update = await check(token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
    if (!update) {
      addLog("info", "updates", "No update available — already on latest version")
      // We were told to check for a specific push but are already current — the
      // job is effectively satisfied, so report it complete rather than leaving
      // it stuck at "acknowledged".
      if (jobId) void centralSocket.reportOtaResult(jobId, true)
      return false
    }

    // Extract SHA-256 from the body if the release notes embed it.
    // Convention: a line matching "SHA-256: <hex>" anywhere in the body.
    const sha256Match = update.body?.match(/SHA-256[:\s]+([a-fA-F0-9]{64})/i)
    const sha256 = sha256Match ? sha256Match[1] : null

    pendingUpdate = {
      version: update.version,
      date: update.date ?? null,
      body: update.body ?? null,
      sha256,
      // Tauri v2 updater enforces signature verification before install, so if
      // we have a pubkey configured and the check succeeded, the bundle is signed.
      signed: isTauri(),
      _raw: update,
      jobId,
    }
    emitUpdate()
    addLog("success", "updates", `Update available: v${update.version}`)
    scheduleQuietInstall(update.rawJson?.install_window)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addLog("error", "updates", `Update check failed: ${message}`)
    if (jobId) void centralSocket.reportOtaResult(jobId, false, undefined, message)
    throw error
  }
}

// ---- Quiet-hours install ----------------------------------------------------

type InstallWindow = { start: string; end: string }
let _quietTimer: ReturnType<typeof setInterval> | null = null

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/** Whether `now` (local time) falls in the window; windows may cross midnight. */
export function inInstallWindow(w: InstallWindow, now = new Date()): boolean {
  const t = now.getHours() * 60 + now.getMinutes()
  const start = toMinutes(w.start), end = toMinutes(w.end)
  return start <= end ? t >= start && t < end : t >= start || t < end
}

/**
 * Releases from central carry an install window (default 02:00–05:00). While
 * an update is pending, check every 5 minutes and install it on our own once
 * we're inside the window, so displays update overnight without anyone
 * tapping. The Install button still works any time.
 */
function scheduleQuietInstall(raw: unknown): void {
  const w = raw as Partial<InstallWindow> | undefined
  if (!w || typeof w.start !== "string" || typeof w.end !== "string" || !/^\d\d:\d\d$/.test(w.start) || !/^\d\d:\d\d$/.test(w.end)) return
  const window = { start: w.start, end: w.end }
  if (_quietTimer) clearInterval(_quietTimer)
  const tick = () => {
    if (!pendingUpdate) {
      if (_quietTimer) { clearInterval(_quietTimer); _quietTimer = null }
      return
    }
    if (!inInstallWindow(window)) return
    addLog("info", "updates", `Installing v${pendingUpdate.version} during quiet hours (${window.start}–${window.end})`)
    void installUpdate().catch(() => {})
  }
  _quietTimer = setInterval(tick, 5 * 60 * 1000)
  tick()
}

// ---- Real-time update polling ---------------------------------------------

let _updatePollInterval: ReturnType<typeof setInterval> | null = null

/**
 * Start polling for updates every `intervalMs` milliseconds (default 1 hour).
 * Safe to call multiple times — only one interval is ever active.
 */
export function startUpdatePolling(intervalMs = 60 * 60 * 1000): void {
  if (_updatePollInterval) return
  // Run once immediately (non-blocking), then on the interval.
  void checkForUpdates().catch(() => {})
  _updatePollInterval = setInterval(() => {
    void checkForUpdates().catch(() => {})
  }, intervalMs)
}

/** Stop the background update poll (call on unmount / cleanup). */
export function stopUpdatePolling(): void {
  if (_updatePollInterval) {
    clearInterval(_updatePollInterval)
    _updatePollInterval = null
  }
}

/** Clear cached web data so the next load is fresh. */
export async function clearCache(): Promise<void> {
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // ignore
  }
  addLog("success", "system", "Cache cleared")
}

/**
 * Factory reset the kiosk device.
 *
 * Steps performed:
 *   1. Clear all in-memory activity logs.
 *   2. Clear all browser/webview caches.
 *   3. Clear localStorage and sessionStorage.
 *   4. On Tauri: invoke the `factory_reset` Rust command which wipes the
 *      on-disk kiosk data directory and then terminates the process.
 *   5. On browser preview: reload so the app returns to the setup wizard.
 */
export async function factoryReset(): Promise<void> {
  // 1. Clear activity log.
  clearLogs()

  // 2. Clear web caches.
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
    }
  } catch {
    // ignore
  }

  // 3. Clear browser storage.
  try {
    localStorage.clear()
    sessionStorage.clear()
  } catch {
    // ignore
  }

  // 4. Tauri: delegate the hard disk wipe + process exit to Rust.
  if (isTauri()) {
    try {
      const { invoke } = await import("@tauri-apps/api/core")
      await invoke("factory_reset")
      // The Rust command calls std::process::exit(0) so we never get here,
      // but add a fallback relaunch just in case.
      const { relaunch } = await import("@tauri-apps/plugin-process")
      await relaunch()
      return
    } catch {
      // fall through
    }
  }

  // 5. Browser preview fallback — reload to the setup wizard.
  window.location.reload()
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  return `${day}d ago`
}
