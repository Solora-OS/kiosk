// ---------------------------------------------------------------------------
// Central Socket.IO client — connects to the central Socket.IO server
//
// This REPLACES liveSocket (local hub socket) for household data sync.
// Also handles: OTA push, device lock/unlock, portal notifications, heartbeats.
//
// Auth: uses the central API device JWT stored under "solora.central.token".
// The kiosk fetches this JWT from the local hub (GET /api/v1/kiosk/central-token).
// Set VITE_CENTRAL_SOCKET_URL to point at the central socket server.
// ---------------------------------------------------------------------------

import { io, type Socket } from "socket.io-client"
import { tokenStore } from "./local-api"
import { LOCAL_API_BASE } from "./hub-address"

const CENTRAL_SOCKET_URL =
  import.meta.env.VITE_CENTRAL_SOCKET_URL?.replace(/\/$/, "") ??
  "http://localhost:5001"

const CENTRAL_API_URL =
  (import.meta.env.VITE_CENTRAL_API_URL as string | undefined)?.replace(/\/$/, "") ??
  "http://localhost:4000"

let cachedVersion: string | null | undefined

/** This build's version from Tauri, or null outside the app (browser dev). */
async function appVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    cachedVersion = await getVersion()
  } catch {
    cachedVersion = null
  }
  return cachedVersion
}

const CENTRAL_TOKEN_KEY = "solora.central.token"
const CENTRAL_DEVICE_ID_KEY = "solora.central.device_id"

export function getCentralToken(): string | null {
  try { return localStorage.getItem(CENTRAL_TOKEN_KEY) } catch { return null }
}

export function setCentralToken(token: string, deviceId?: string) {
  try {
    localStorage.setItem(CENTRAL_TOKEN_KEY, token)
    if (deviceId) localStorage.setItem(CENTRAL_DEVICE_ID_KEY, deviceId)
  } catch { /* ignore */ }
}

export function getCentralDeviceId(): string | null {
  try { return localStorage.getItem(CENTRAL_DEVICE_ID_KEY) } catch { return null }
}

// The newest revision of each provisioning profile this display applied or
// declined, so a catch-up doesn't ask the family again.
const PROVISION_KEY = "solora.provision.handled"

function handledRevision(profileId: string): number {
  try { return (JSON.parse(localStorage.getItem(PROVISION_KEY) ?? "{}") as Record<string, number>)[profileId] ?? 0 } catch { return 0 }
}

function markHandled(profileId: string, revision: number) {
  try {
    const all = JSON.parse(localStorage.getItem(PROVISION_KEY) ?? "{}") as Record<string, number>
    localStorage.setItem(PROVISION_KEY, JSON.stringify({ ...all, [profileId]: revision }))
  } catch { /* ignore */ }
}

// ─── Event types ──────────────────────────────────────────────────────────────
export interface OtaPushPayload {
  /** Install now instead of waiting for the release's quiet hours (console "Force update"). */
  force?:    boolean
  job_id?:   string
  version:   string
  url:       string
  signature?: string
  notes?:    string
  ts:        string
}

/** provision:update — a provisioning profile from the console (central/src/routes/fleet.ts). */
export interface ProvisionPayload {
  profile_id: string
  name:       string
  revision:   number
  mode:       "prompt" | "apply"
  settings:   {
    update_channel?: string
    install_window?: { start: string; end: string }
    display?: {
      orientation?: "normal" | "left" | "right" | "inverted" | "portrait"; idle_mins?: number | null
      brightness?: number; volume?: number; theme?: "light" | "dark" | "system"; season_effects?: boolean
    }
    features?: Record<string, boolean>
    timezone?: string; locale?: string; message?: string
  }
  ts: string
}

export interface DeviceLockPayload {
  device_id: string
  locked:    boolean
  reason?:   string
  ts:        string
}

export interface NotificationPayload {
  notification_id?: string
  title:  string
  body:   string
  data?:  Record<string, unknown>
  ts:     string
}

// hub:command mirrors the local hub's HubCommandEvent type
export type HubCommandEvent =
  | { type: "restart" }
  | { type: "reload" }
  | { type: "clear_cache" }
  | { type: "set_orientation"; orientation: "normal" | "left" | "right" | "inverted" | "portrait" }
  | { type: "set_idle_mins"; minutes: number | null }
  | { type: "set_brightness"; level: number }
  | { type: "set_volume"; level: number }
  | { type: "set_muted"; muted: boolean }
  | { type: "set_theme"; theme: "light" | "dark" | "system" }
  | { type: "set_season"; mode: string }
  | { type: "set_season_effects"; on: boolean }
  | { type: "display_sleep" }
  | { type: "display_wake" }

// Table names that produce table:action events (relayed from hub broadcaster)
const TABLE_EVENTS = [
  "members", "invites", "calendars", "events", "chores",
  "lists", "list_items", "meals", "notifications", "photos",
  "households", "kiosk_devices",
] as const

type TableChangeListener    = () => void
type HubCommandListener     = (cmd: HubCommandEvent) => void
type OtaPushListener        = (payload: OtaPushPayload) => void
type DeviceLockListener     = (payload: DeviceLockPayload) => void
type NotificationListener   = (payload: NotificationPayload) => void
type RebootListener         = () => void
type ReportStatusListener   = () => void
type ProvisionListener      = (payload: ProvisionPayload) => void
type FlagsListener          = (flags: Record<string, boolean>) => void
type ReportLogsListener     = (sinceMinutes: number) => void
type ConnectListener        = () => void
type DisconnectListener     = (reason: string) => void

// ─── CentralSocket class ──────────────────────────────────────────────────────
class CentralSocket {
  private socket: Socket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private catchUpTimer: ReturnType<typeof setInterval> | null = null

  private tableChangeListeners   = new Set<TableChangeListener>()
  private hubCommandListeners    = new Set<HubCommandListener>()
  private otaPushListeners       = new Set<OtaPushListener>()
  private lockListeners          = new Set<DeviceLockListener>()
  private notifListeners         = new Set<NotificationListener>()
  private rebootListeners        = new Set<RebootListener>()
  private reportStatusListeners  = new Set<ReportStatusListener>()
  private provisionListeners   = new Set<ProvisionListener>()
  private flagsListeners       = new Set<FlagsListener>()
  private reportLogsListeners  = new Set<ReportLogsListener>()
  private connectListeners       = new Set<ConnectListener>()
  private disconnectListeners    = new Set<DisconnectListener>()

  /**
   * Connect to the central socket server.
   * Call this after receiving a central API JWT (e.g. after kiosk registration).
   */
  connect(token?: string) {
    const t = token ?? getCentralToken()
    if (!t) {
      console.warn("[central-socket] No central token — skipping connection")
      return
    }

    if (this.socket?.connected) return
    this.disconnect()

    if (token) setCentralToken(token)

    this.socket = io(CENTRAL_SOCKET_URL, {
      auth:        { token: t },
      transports:  ["websocket"],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 10_000,
    })

    this.socket.on("connect", () => {
      console.info("[central-socket] connected")
      this.startHeartbeat()
      this.startCatchUpPolling()
      // Catch up immediately on (re)connect — covers both "was offline when portal
      // pushed ota:push / device:lock" and "missed the live event during a network blip".
      void this.checkPendingOta()
      void this.checkLockStatus()
      void this.checkConfig()
      for (const l of this.connectListeners) l()
    })

    this.socket.on("disconnect", (reason: string) => {
      console.info("[central-socket] disconnected:", reason)
      this.stopHeartbeat()
      this.stopCatchUpPolling()
      for (const l of this.disconnectListeners) l(reason)
    })

    // ── Inbound events ────────────────────────────────────────────────────────
    this.socket.on("ota:push", (payload: OtaPushPayload) => {
      console.info("[central-socket] ota:push", payload.version)
      this.handleOtaPush(payload)
    })

    this.socket.on("device:lock", (payload: DeviceLockPayload) => {
      console.info("[central-socket] device:lock", payload.locked)
      this.handleDeviceLock(payload)
    })

    this.socket.on("notification:receive", (payload: NotificationPayload) => {
      console.info("[central-socket] notification", payload.title)
      for (const l of this.notifListeners) l(payload)
    })

    this.socket.on("device:reboot", () => {
      console.info("[central-socket] device:reboot")
      for (const l of this.rebootListeners) l()
    })

    this.socket.on("device:report-status", () => {
      this.emitStatus()
      for (const l of this.reportStatusListeners) l()
    })

    // ── Fleet control from the console (provisioning, flags, log collection)
    this.socket.on("provision:update", (payload: ProvisionPayload) => {
      console.info("[central-socket] provision:update", payload.name, payload.revision, payload.mode)
      for (const l of this.provisionListeners) l(payload)
    })

    this.socket.on("flags:update", (payload: { flags: Record<string, boolean> }) => {
      for (const l of this.flagsListeners) l(payload.flags ?? {})
    })

    this.socket.on("device:report-logs", (payload: { since_minutes?: number }) => {
      for (const l of this.reportLogsListeners) l(payload?.since_minutes ?? 60)
    })

    // ── Household data sync (table:action events relayed from hub broadcaster)
    for (const table of TABLE_EVENTS) {
      for (const action of ["created", "updated", "deleted"] as const) {
        this.socket.on(`${table}:${action}`, () => {
          for (const l of this.tableChangeListeners) l()
        })
      }
    }

    // ── Hub remote commands (restart, reload, orientation, etc.)
    this.socket.on("hub:command", (cmd: HubCommandEvent) => {
      console.info("[central-socket] hub:command", cmd.type)
      for (const l of this.hubCommandListeners) l(cmd)
    })
  }

  /**
   * Fetch the central API JWT from the local hub and store it.
   * The hub provides this after it registers with the central API on startup.
   * Returns the token on success, null if not available yet (retry).
   */
  async fetchAndStoreCentralToken(localDeviceId: string): Promise<string | null> {
    const deviceToken = tokenStore.get()
    if (!deviceToken) return null
    try {
      const headers = { Authorization: `Bearer ${deviceToken}` }
      let res = await fetch(`${LOCAL_API_BASE}/api/v1/kiosk/central-token/${localDeviceId}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      // 503 = hub hasn't registered this kiosk yet — trigger on-demand registration
      if (res.status === 503) {
        res = await fetch(`${LOCAL_API_BASE}/api/v1/kiosk/request-central-token`, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(10000),
        })
      }
      if (!res.ok) return null
      const data = (await res.json()) as { token: string }
      setCentralToken(data.token, localDeviceId)
      return data.token
    } catch {
      return null
    }
  }

  disconnect() {
    this.stopHeartbeat()
    this.stopCatchUpPolling()
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
  }

  private handleOtaPush(payload: OtaPushPayload) {
    for (const l of this.otaPushListeners) l(payload)
  }

  private handleDeviceLock(payload: DeviceLockPayload) {
    for (const l of this.lockListeners) l(payload)
  }

  private async fetchCentral<T>(path: string, init?: RequestInit): Promise<T | null> {
    const t = getCentralToken()
    if (!t) return null
    try {
      const res = await fetch(`${CENTRAL_API_URL}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) return null
      return (await res.json()) as T
    } catch {
      return null
    }
  }

  /**
   * Ask the central API directly whether we have a pending OTA job.
   * This is what makes delivery work for a device that was offline (or not yet
   * connected) when the portal pushed the update — the live `ota:push` socket event
   * only reaches devices connected at push time. Called on every connect/reconnect
   * plus a 5-minute fallback interval in case a live event was dropped mid-session.
   */
  async checkPendingOta(): Promise<void> {
    const data = await this.fetchCentral<{
      pending: boolean
      job?: { id: string; version: string; download_url: string; changelog?: string }
    }>("/devices/ota/check")
    if (!data?.pending || !data.job) return

    await this.fetchCentral(`/devices/ota/${data.job.id}/ack`, { method: "POST" })
    console.info("[central-socket] caught up on missed ota:push", data.job.version)
    this.handleOtaPush({
      job_id:  data.job.id,
      version: data.job.version,
      url:     data.job.download_url,
      notes:   data.job.changelog,
      ts:      new Date().toISOString(),
    })
  }

  /**
   * Ask the central API directly for our current maintenance-lock state.
   * Complements the live `device:lock` push the same way checkPendingOta complements
   * ota:push — a device locked (or unlocked) while offline picks up the correct state
   * as soon as it reconnects, instead of silently ignoring a lock it never received.
   */
  async checkLockStatus(): Promise<void> {
    const data = await this.fetchCentral<{ locked: boolean; reason: string | null }>("/devices/lock-status")
    if (!data) return
    this.handleDeviceLock({
      device_id: getCentralDeviceId() ?? "",
      locked:    data.locked,
      reason:    data.reason ?? undefined,
      ts:        new Date().toISOString(),
    })
  }

  /**
   * Catch up on the hub's provisioning profile and feature flags
   * (GET /devices/config) — covers pushes made while this display was offline.
   * A profile is only re-raised if this display hasn't handled that revision yet.
   */
  async checkConfig(): Promise<void> {
    const data = await this.fetchCentral<{ provision: ProvisionPayload | null; flags: Record<string, boolean> }>("/devices/config")
    if (!data) return
    for (const l of this.flagsListeners) l(data.flags ?? {})
    if (data.provision && handledRevision(data.provision.profile_id) < data.provision.revision) {
      for (const l of this.provisionListeners) l(data.provision)
    }
  }

  /**
   * Runs a hub command through the same handlers a remote one uses (app shell,
   * display remote), so a provisioning profile applies settings exactly the
   * way the console's display controls do.
   */
  applyLocally(cmd: HubCommandEvent) {
    for (const l of this.hubCommandListeners) l(cmd)
  }

  /** Tells central what this display did with a profile push. */
  emitProvisionResult(p: Pick<ProvisionPayload, "profile_id" | "revision">, status: "applied" | "prompted" | "declined" | "failed", error?: string) {
    if (status !== "prompted") markHandled(p.profile_id, p.revision)
    this.socket?.emit("provision:result", { profile_id: p.profile_id, revision: p.revision, status, ...(error ? { error } : {}) })
  }

  /**
   * Report the outcome of applying an OTA job — both live (socket, for portal
   * dashboards watching in real time) and durably (REST, so ota_push_jobs actually
   * reaches 'complete'/'failed' instead of sitting at 'acknowledged' forever).
   */
  async reportOtaResult(jobId: string | undefined, success: boolean, version?: string, error?: string) {
    this.emitOtaResult(success, version, error)
    if (!jobId) return
    await this.fetchCentral(`/devices/ota/${jobId}/complete`, {
      method: "POST",
      body:   JSON.stringify({ success, app_version: version, error }),
    })
  }

  get connected(): boolean {
    return this.socket?.connected ?? false
  }

  // ─── Outbound events ───────────────────────────────────────────────────────
  emitHeartbeat(data?: { cpu_temp?: number; wifi_signal?: number; app_version?: string }) {
    this.socket?.emit("device:heartbeat", data ?? {})
  }

  emitStatus(status?: string) {
    this.socket?.emit("device:status", { status: status ?? "online" })
  }

  emitOtaProgress(percent: number, stage: string) {
    this.socket?.emit("ota:progress", { percent, stage })
  }

  emitOtaResult(success: boolean, version?: string, error?: string) {
    this.socket?.emit("ota:result", { success, version, error })
  }

  emitLog(level: "info" | "warn" | "error", message: string) {
    this.socket?.emit("device:log", { level, message })
  }

  notificationAck(notificationId: string) {
    this.socket?.emit("notification:ack", { notification_id: notificationId })
  }

  // ─── Subscriptions ─────────────────────────────────────────────────────────
  /** Fires whenever a table:action event arrives — triggers a data re-sync. */
  onTableChange(cb: TableChangeListener)  { this.tableChangeListeners.add(cb);  return () => this.tableChangeListeners.delete(cb) }
  onHubCommand(cb: HubCommandListener)   { this.hubCommandListeners.add(cb);   return () => this.hubCommandListeners.delete(cb) }
  onOtaPush(cb: OtaPushListener)         { this.otaPushListeners.add(cb);      return () => this.otaPushListeners.delete(cb) }
  onDeviceLock(cb: DeviceLockListener)   { this.lockListeners.add(cb);         return () => this.lockListeners.delete(cb) }
  onNotification(cb: NotificationListener){ this.notifListeners.add(cb);       return () => this.notifListeners.delete(cb) }
  onReboot(cb: RebootListener)           { this.rebootListeners.add(cb);       return () => this.rebootListeners.delete(cb) }
  onReportStatus(cb: ReportStatusListener){ this.reportStatusListeners.add(cb); return () => this.reportStatusListeners.delete(cb) }
  onProvision(cb: ProvisionListener)     { this.provisionListeners.add(cb);    return () => this.provisionListeners.delete(cb) }
  onFlags(cb: FlagsListener)             { this.flagsListeners.add(cb);        return () => this.flagsListeners.delete(cb) }
  onReportLogs(cb: ReportLogsListener)   { this.reportLogsListeners.add(cb);   return () => this.reportLogsListeners.delete(cb) }
  onConnect(cb: ConnectListener)         { this.connectListeners.add(cb);      return () => this.connectListeners.delete(cb) }
  onDisconnect(cb: DisconnectListener)   { this.disconnectListeners.add(cb);   return () => this.disconnectListeners.delete(cb) }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  // Every 30 s, and right after connecting. Central keeps app_version per
  // device: the console's Fleet view and rollout health (displays on a
  // version, displays gone quiet) depend on it. The kiosk has no real Wi-Fi
  // or temperature reading, so it doesn't invent one.
  private startHeartbeat() {
    this.stopHeartbeat()
    const beat = () => { void appVersion().then((v) => this.emitHeartbeat(v ? { app_version: v } : undefined)) }
    beat()
    this.heartbeatTimer = setInterval(beat, 30_000)
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  // ─── OTA / lock catch-up polling ───────────────────────────────────────────
  private startCatchUpPolling() {
    this.stopCatchUpPolling()
    this.catchUpTimer = setInterval(() => {
      void this.checkPendingOta()
      void this.checkLockStatus()
      void this.checkConfig()
    }, 5 * 60_000) // every 5 min
  }

  private stopCatchUpPolling() {
    if (this.catchUpTimer) {
      clearInterval(this.catchUpTimer)
      this.catchUpTimer = null
    }
  }
}

/** Singleton — shared across the kiosk app. */
export const centralSocket = new CentralSocket()

// Auto-connect on load if a central token already exists in storage
const existingToken = getCentralToken()
if (existingToken) {
  centralSocket.connect(existingToken)
}
