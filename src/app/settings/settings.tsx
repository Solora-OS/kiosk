"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { kioskToast } from "@/components/os/kiosk-toast"
import {
  ChevronRight,
  Bell,
  RefreshCw,
  Moon,
  Sun,
  Monitor,
  Send,
  ShieldCheck,
  LogOut,
  Trash2,
  Lock,
  Power,
  RotateCcw,
  ScrollText,
  DownloadCloud,
  Eraser,
  Info,
  AlertTriangle,
  CheckCircle2,
  Cake,
  Mail,
  UserPlus,
  Unplug,
  UserCheck,
  Copy,
  Check,
  QrCode as QrCodeIcon,
  MonitorSmartphone,
  Link2Off,
  Globe,
  Clock,
  Wifi,
  User,
  Timer,
  Images,
  Users,
  Palette,
  CalendarDays,
  Wrench,
  ShieldAlert,
  Tablet,
  type LucideIcon
} from "lucide-react"
import { OrbitLoader, SkeletonBlock } from "@/components/os/orbit"
import {
  roleLabels,
  calculateAge,
  memberBg,
  type Member,
  type MemberColor,
  type MemberRole,
  type PermissionArea,
} from "@/lib/data"
import { cn } from "@/lib/utils"
import { useTheme, type Theme } from "@/components/theme-provider"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { PermissionPicker, defaultPermissions } from "@/components/ui/reusables/permission-picker"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { BottomSheet } from "@/components/ui/reusables/bottom-sheet"
import { QrCode } from "@/components/ui/reusables/qr-code"
import { useStore } from "@/lib/store"
import { useOptionalAuth } from "@/lib/auth"
import { kioskConfig } from "@/lib/kiosk"
import { useKiosk } from "@/lib/kiosk-provider"
import { type Invite } from "@/lib/api"
import { KioskStatusWidget } from "@/components/ui/reusables/kiosk-status-widget"
import {
  getPushPermission,
  requestPushPermission,
  sendTestNotification,
  isPushSupported,
  type PushPermission,
} from "@/lib/push"
import {
  restartHub,
  reloadDisplay,
  checkForUpdates,
  clearCache,
  factoryReset,
  getLogs,
  subscribeLogs,
  clearLogs,
  relativeTime,
  startUpdatePolling,
  stopUpdatePolling,
  getPendingUpdate,
  subscribeUpdate,
  isHubDevice,
  type HubLogLevel,
} from "@/lib/hub"
import { sendHubCommand } from "@/lib/local-api"
import {
  getLanguage,
  setLanguage,
  getTimezone,
  setTimezone,
  setOrientation,
  type ScreenOrientation,
} from "@/lib/locale-service"
import {
  scanNetworks,
  connect as wifiConnect,
  currentNetwork,
  needsPassword,
  type WifiNetwork,
} from "@/lib/wifi-service"
import { patchDeviceState } from "@/lib/device-state"
import { AppearanceSection, SoundDisplaySection } from "@/app/settings/appearance-section"
import { HomeScreenSection, InterfaceSection } from "@/app/settings/interface-section"
import { CalendarImportSheet } from "@/app/calendar/CalendarImportSheet"
import { ActivityLog } from "@/app/settings/ActivityLog"
import { LOCAL_API_BASE, tokenStore } from "@/lib/local-api"
import { centralSocket, getCentralToken } from "@/lib/central-socket"
import { getLocalDeviceId, saveTimezone } from "@/lib/kiosk-session"


function Toggle({
  label,
  description,
  icon: Icon,
  defaultOn = false,
}: {
  label: string
  description?: string
  icon: LucideIcon
  defaultOn?: boolean
}) {
  const [on, setOn] = useState(defaultOn)
  return (
    <div className="flex items-center gap-3 px-4 py-4">
      <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        onClick={() => setOn((v) => !v)}
        className={cn(
          "relative h-8 w-14 shrink-0 rounded-md transition-colors",
          on ? "bg-foreground" : "bg-secondary shadow-[inset_0_0_0_1px_var(--border)]",
        )}
      >
        <span
          className={cn(
            "absolute top-1 size-6 rounded-[5px] transition-all",
            on ? "left-7 bg-season" : "left-1 bg-muted-foreground/60",
          )}
        />
      </button>
    </div>
  )
}

function ActionRow({
  label,
  description,
  icon: Icon,
  onClick,
  destructive = false,
  trailing,
}: {
  label: string
  description?: string
  icon: LucideIcon
  onClick?: () => void
  destructive?: boolean
  trailing?: React.ReactNode
}) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-secondary/60">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm font-medium", destructive && "text-destructive")}>{label}</span>
        {description ? <span className="block text-xs text-muted-foreground">{description}</span> : null}
      </span>
      {trailing ?? <ChevronRight className={cn("size-4", destructive ? "text-destructive/60" : "text-muted-foreground")} />}
    </button>
  )
}

const permissionMeta: Record<PushPermission, { label: string; className: string }> = {
  granted: { label: "Enabled", className: "bg-member-green/15 text-member-green" },
  denied: { label: "Blocked", className: "bg-destructive/15 text-destructive" },
  default: { label: "Not set", className: "bg-secondary text-muted-foreground" },
  unsupported: { label: "Unavailable", className: "bg-secondary text-muted-foreground" },
}

function PushNotificationsSection() {
  const { addNotification } = useStore()
  const [permission, setPermission] = useState<PushPermission>("default")

  useEffect(() => {
    let active = true
    getPushPermission().then((p) => {
      if (active) setPermission(p)
    })
    return () => {
      active = false
    }
  }, [])

  const meta = permissionMeta[permission]
  const supported = isPushSupported()

  const enable = async () => {
    const result = await requestPushPermission()
    setPermission(result)
    if (result === "granted") {
      kioskToast.success("Push notifications enabled")
    } else {
      kioskToast.error(`Permission ${result}`)
    }
  }

  const test = async () => {
    const ok = await sendTestNotification({
      title: "Solora Hub",
      body: "Test notification — push is working!",
    })
    setPermission(await getPushPermission())
    addNotification({
      title: "Test notification",
      body: ok ? "Delivered to your device." : "Could not deliver — check permissions.",
      time: "Just now",
      memberId: "family",
      read: false,
    })
    if (ok) {
      kioskToast.success("Test notification sent")
    } else {
      kioskToast.error("Enable notifications first")
    }
  }

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Push Notifications</h2>
      <div className="overflow-hidden rounded-md border border-hairline bg-card">
        <div className="flex items-center gap-3 px-4 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
            <Bell className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Device permission</span>
            <span className="block text-xs text-muted-foreground">
              {supported ? "Allow alerts on this device" : "Not supported in this environment"}
            </span>
          </span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.75rem] font-semibold", meta.className)}>
            {meta.label}
          </span>
        </div>

        <div className="flex gap-2 border-t border-hairline px-4 py-3">
          <button
            type="button"
            onClick={enable}
            disabled={!supported || permission === "granted"}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <ShieldCheck className="size-4" />
            {permission === "granted" ? "Allowed" : "Enable"}
          </button>
          <button
            type="button"
            onClick={test}
            disabled={!supported}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-secondary py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-40"
          >
            <Send className="size-4" />
            Send test
          </button>
        </div>

        {permission === "denied" ? (
          <p className="border-t border-hairline px-4 py-2.5 text-xs text-muted-foreground">
            Notifications are blocked. Re-enable them in your device or browser settings.
          </p>
        ) : null}
      </div>
    </section>
  )
}

const logLevelMeta: Record<HubLogLevel, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: "text-member-blue" },
  success: { icon: CheckCircle2, className: "text-member-green" },
  warning: { icon: AlertTriangle, className: "text-member-amber" },
  error: { icon: AlertTriangle, className: "text-destructive" },
}

function HistoryLogsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const logs = useSyncExternalStore(subscribeLogs, getLogs, getLogs)

  return (
    <BottomSheet open={open} onClose={onClose} title="Activity logs">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{logs.length} recent events</p>
        <button
          type="button"
          onClick={() => clearLogs()}
          disabled={logs.length === 0}
          className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-40"
        >
          <Eraser className="size-3.5" />
          Clear
        </button>
      </div>
      <ul className="max-h-[55vh] divide-y divide-hairline overflow-y-auto overscroll-contain rounded-md bg-background">
        {logs.length === 0 ? (
          <li className="px-4 py-10 text-center text-sm text-muted-foreground">No log entries</li>
        ) : (
          logs.map((entry) => {
            const meta = logLevelMeta[entry.level]
            const Icon = meta.icon
            return (
              <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                <Icon className={cn("mt-0.5 size-4 shrink-0", meta.className)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {entry.source}
                    </span>
                    <span className="shrink-0 text-[0.75rem] text-muted-foreground">{relativeTime(entry.time)}</span>
                  </div>
                  <p className="text-sm leading-snug">{entry.message}</p>
                </div>
              </li>
            )
          })
        )}
      </ul>
    </BottomSheet>
  )
}

// ─── Central Connection Section ───────────────────────────────────────────────

function CentralConnectionSection() {
  const [connected, setConnected] = useState(centralSocket.connected)
  const [hasToken, setHasToken] = useState(!!getCentralToken())
  const [busy, setBusy] = useState(false)

  // Keep connected state in sync
  useEffect(() => {
    const unsub = centralSocket.onDisconnect(() => setConnected(false))
    const interval = setInterval(() => setConnected(centralSocket.connected), 2000)
    return () => { unsub(); clearInterval(interval) }
  }, [])

  const reconnect = async () => {
    setBusy(true)
    try {
      const localDeviceId = getLocalDeviceId()
      if (!localDeviceId) {
        kioskToast.error("Device not registered with local hub yet — try restarting the app")
        return
      }
      const token = await centralSocket.fetchAndStoreCentralToken(localDeviceId)
      if (!token) {
        kioskToast.error("This display isn't connected to Solora yet. Restart the hub and try again.")
        return
      }
      centralSocket.connect(token)
      setHasToken(true)
      setConnected(centralSocket.connected)
      kioskToast.success("Reconnected to central server")
    } catch (e) {
      kioskToast.error(e instanceof Error ? e.message : "Reconnect failed")
    } finally {
      setBusy(false)
    }
  }

  const reRegister = async () => {
    setBusy(true)
    try {
      centralSocket.disconnect()
      localStorage.removeItem("lumora.central.token")
      setHasToken(false)
      setConnected(false)
      const localDeviceId = getLocalDeviceId()
      if (!localDeviceId) {
        kioskToast.error("This display hasn't registered with the hub yet. Wait a moment and try again.")
        return
      }
      const token = await centralSocket.fetchAndStoreCentralToken(localDeviceId)
      if (!token) {
        kioskToast.error("This display isn't connected to Solora yet. Restart the hub and try again.")
        return
      }
      centralSocket.connect(token)
      setHasToken(true)
      setConnected(centralSocket.connected)
      kioskToast.success("Re-registered with central server")
    } catch (e) {
      kioskToast.error(e instanceof Error ? e.message : "Re-registration failed")
    } finally {
      setBusy(false)
    }
  }

  const statusClass = connected
    ? "bg-member-green/15 text-member-green"
    : hasToken
      ? "bg-member-amber/15 text-member-amber"
      : "bg-secondary text-muted-foreground"
  const statusLabel = connected ? "Connected" : hasToken ? "Disconnected" : "Not registered"

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Cloud Connection</h2>
      <div className="overflow-hidden rounded-md border border-hairline bg-card">
        <div className="flex items-center gap-3 px-4 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
            <Globe className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Central server</span>
            <span className="block text-xs text-muted-foreground">
              {connected ? "Live data sync active" : hasToken ? "Token stored, socket offline" : "Not yet registered"}
            </span>
          </span>
          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[0.75rem] font-semibold", statusClass)}>
            {statusLabel}
          </span>
        </div>
        <div className="flex gap-2 border-t border-hairline px-4 py-3">
          <button
            type="button"
            onClick={() => void reconnect()}
            disabled={busy || connected}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {busy ? <OrbitLoader size={16} /> : <RefreshCw className="size-4" />}
            Reconnect
          </button>
          <button
            type="button"
            onClick={() => void reRegister()}
            disabled={busy}
            className="flex flex-1 items-center justify-center gap-2 rounded-md bg-secondary py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-40"
          >
            {busy ? <OrbitLoader size={16} /> : <RotateCcw className="size-4" />}
            Re-register
          </button>
        </div>
      </div>
    </section>
  )
}

function HubActionsSection() {
  const { can } = useStore()
  const [logsOpen, setLogsOpen] = useState(false)
  const [confirmRestart, setConfirmRestart] = useState(false)
  const [checking, setChecking] = useState(false)
  const pendingUpdate = useSyncExternalStore(subscribeUpdate, getPendingUpdate, getPendingUpdate)

  // Start polling for updates when the settings tab is mounted; stop on unmount.
  useEffect(() => {
    startUpdatePolling(60 * 60 * 1000) // 1-hour interval
    return () => stopUpdatePolling()
  }, [])

  const onCheckUpdates = async () => {
    setChecking(true)
    try {
      const available = await checkForUpdates()
      if (!available) {
        kioskToast.success("Already on the latest version")
      }
      // If available, the UpdateDialog opens automatically via useSyncExternalStore.
    } catch {
      kioskToast.error("Failed to check for updates — check your connection")
    } finally {
      setChecking(false)
    }
  }

  const onReloadDisplay = async () => {
    if (isHubDevice()) {
      reloadDisplay()
    } else {
      try {
        await sendHubCommand({ type: "reload" })
        kioskToast.success("Reload sent to hub")
      } catch {
        kioskToast.error("Could not reach hub")
      }
    }
  }

  const onClearCache = async () => {
    if (isHubDevice()) {
      await clearCache()
      kioskToast.success("Cache cleared")
    } else {
      try {
        await sendHubCommand({ type: "clear_cache" })
        kioskToast.success("Clear cache sent to hub")
      } catch {
        kioskToast.error("Could not reach hub")
      }
    }
  }

  const onConfirmRestart = async () => {
    setConfirmRestart(false)
    if (isHubDevice()) {
      void restartHub()
    } else {
      try {
        await sendHubCommand({ type: "restart" })
        kioskToast.success("Restart command sent to hub")
      } catch {
        kioskToast.error("Could not reach hub")
      }
    }
  }

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Hub Actions</h2>
      <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-card">
        <ActionRow
          icon={ScrollText}
          label="Activity logs"
          description="View recent hub events"
          onClick={() => setLogsOpen(true)}
        />
        <ActionRow
          icon={DownloadCloud}
          label="Check for updates"
          description={
            pendingUpdate
              ? `v${pendingUpdate.version} available`
              : "Check for the latest release"
          }
          onClick={onCheckUpdates}
          trailing={
            checking ? (
              <OrbitLoader size={16} className="text-muted-foreground" />
            ) : pendingUpdate ? (
              <span className="flex items-center gap-1.5 rounded-full bg-member-green/15 px-2.5 py-1 text-[0.75rem] font-semibold text-member-green">
                <DownloadCloud className="size-3" />
                Update ready
              </span>
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )
          }
        />
        <ActionRow
          icon={RotateCcw}
          label="Reload display"
          description="Refresh the on-screen UI"
          onClick={() => void onReloadDisplay()}
        />
        <ActionRow
          icon={Eraser}
          label="Clear cache"
          description="Free up cached web data"
          onClick={() => void onClearCache()}
        />
        {can("hub") ? (
          <ActionRow
            icon={Power}
            label="Restart hub"
            description="Turn the hub off and on again"
            onClick={() => setConfirmRestart(true)}
            destructive
          />
        ) : null}
      </div>

      <HistoryLogsSheet open={logsOpen} onClose={() => setLogsOpen(false)} />

      <ConfirmDialog
        open={confirmRestart}
        title="Restart hub?"
        message="The display will go dark and reboot. This takes about a minute."
        confirmLabel="Restart"
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => void onConfirmRestart()}
      />
    </section>
  )
}

const colorOptions: MemberColor[] = ["coral", "amber", "teal", "blue", "pink", "green"]
const roleOptions: MemberRole[] = ["admin", "adult", "teen", "child"]

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

const inputClass =
  "w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"

type MemberDraft = {
  name: string
  dob: string
  role: MemberRole
  color: MemberColor
  account: string
  permissions: PermissionArea[]
}

function toDraft(member: Member | null): MemberDraft {
  return {
    name: member?.name ?? "",
    dob: member?.dob ?? "",
    role: member?.role ?? "child",
    color: member?.color ?? "blue",
    account: member?.account ?? "",
    permissions: member?.permissions ?? [],
  }
}

function MemberSheet({
  open,
  member,
  onClose,
  onDelete,
  onInvite,
}: {
  open: boolean
  member: Member | null
  onClose: () => void
  onDelete?: () => void
  onInvite?: () => void
}) {
  const { addMember, updateMember } = useStore()
  const auth = useOptionalAuth()
  const user = auth?.user ?? null
  const [draft, setDraft] = useState<MemberDraft>(() => toDraft(member))
  const [permsTouched, setPermsTouched] = useState(false)

  // Re-seed the form whenever a different member (or add mode) opens.
  useEffect(() => {
    if (!open) return
    setDraft(toDraft(member))
    setPermsTouched(false)
  }, [open, member])

  const isEdit = !!member
  const age = calculateAge(draft.dob || undefined)
  const set = <K extends keyof MemberDraft>(key: K, value: MemberDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const save = () => {
    const name = draft.name.trim()
    if (!name) return
    // Admins implicitly have every permission, so we don't store a list for them.
    const permissions = draft.role === "admin" ? undefined : draft.permissions

    if (isEdit && member) {
      updateMember(member.id, {
        name,
        dob: draft.dob || undefined,
        role: draft.role,
        color: draft.color,
        account: draft.account.trim() || undefined,
        permissions,
      })
    } else {
      addMember({
        name,
        dob: draft.dob || undefined,
        role: draft.role,
        color: draft.color,
        account: draft.account.trim() || undefined,
        permissions,
      })
    }
    onClose()
  }

  // A new member starts from their role's usual permissions until someone picks their own.
  const pickRole = (role: MemberRole) =>
    setDraft((d) => ({ ...d, role, permissions: !isEdit && !permsTouched ? defaultPermissions(role) : d.permissions }))

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit member" : "Add member"}
      footer={
        <button
          type="button"
          onClick={save}
          disabled={!draft.name.trim()}
          className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {isEdit ? "Save changes" : "Add member"}
        </button>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <input
            className={inputClass}
            value={draft.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="Full name"
            autoFocus={!isEdit}
          />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth">
            <input
              type="date"
              className={inputClass}
              value={draft.dob}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => set("dob", e.target.value)}
            />
          </Field>
          <Field label="Age">
            <div className="flex items-center gap-2 rounded-md border border-border bg-secondary/40 px-3 py-2.5 text-sm">
              <Cake className="size-4 text-muted-foreground" />
              <span>{age === null ? "—" : `${age} yrs`}</span>
            </div>
          </Field>
        </div>

        <Field label="Role">
          <div className="grid grid-cols-4 gap-1.5">
            {roleOptions.map((r) => {
              const active = draft.role === r
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => pickRole(r)}
                  aria-pressed={active}
                  className={cn(
                    "rounded-md py-2 text-xs font-semibold transition-colors",
                    active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground",
                  )}
                >
                  {roleLabels[r]}
                </button>
              )
            })}
          </div>
        </Field>

        <Field label="Color">
          <div className="flex gap-2">
            {colorOptions.map((c) => {
              const active = draft.color === c
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => set("color", c)}
                  aria-label={c}
                  aria-pressed={active}
                  className={cn(
                    "size-8 rounded-full transition-transform",
                    memberBg[c],
                    active ? "ring-2 ring-foreground ring-offset-2 ring-offset-card" : "hover:scale-105",
                  )}
                />
              )
            })}
          </div>
        </Field>

        <Field label="Connected account">
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="email"
              className={cn(inputClass, "pl-9")}
              value={draft.account}
              onChange={(e) => set("account", e.target.value)}
              placeholder="name@family.com"
            />
          </div>
          {user && user.email && draft.account.trim().toLowerCase() !== user.email.toLowerCase() ? (
            <button
              type="button"
              onClick={() => set("account", user.email!)}
              className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-primary"
            >
              <UserCheck className="size-3.5" />
              This is me — link my account ({user.email})
            </button>
          ) : null}
          {user && user.email && draft.account.trim().toLowerCase() === user.email.toLowerCase() ? (
            <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-member-green">
              <Check className="size-3.5" />
              Linked to your account
            </p>
          ) : null}
        </Field>

        {/* Invite to app */}
        {isEdit && onInvite ? (
          <button
            type="button"
            onClick={onInvite}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
          >
            <QrCodeIcon className="size-4 text-primary" />
            Invite to the app
          </button>
        ) : null}

        {/* Permissions — admins implicitly have everything */}
        {draft.role === "admin" ? (
          <div className="flex items-start gap-3 rounded-md border border-border/70 p-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
              <ShieldCheck className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Full access</span>
              <span className="block text-xs text-muted-foreground">
                Admins can manage everything in the household.
              </span>
            </span>
          </div>
        ) : (
          <PermissionPicker
            // Each opening starts folded.
            key={`${member?.id ?? "new"}:${open}`}
            name={draft.name}
            value={draft.permissions}
            onChange={(permissions) => {
              setPermsTouched(true)
              set("permissions", permissions)
            }}
          />
        )}

        {isEdit && onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-destructive/10 py-3 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/15"
          >
            <Trash2 className="size-4" />
            Remove member
          </button>
        ) : null}
      </div>
    </BottomSheet>
  )
}

function InviteSheet({
  open,
  member,
  onClose,
}: {
  open: boolean
  member: Member | null
  onClose: () => void
}) {
  const { inviteMember, cancelInvite } = useStore()
  const [invite, setInvite] = useState<Invite | null>(null)
  const [busy, setBusy] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copiedLink, setCopiedLink] = useState(false)

  const generate = () => {
    if (!member) return
    setError(null)
    setBusy(true)
    inviteMember(member)
      .then(setInvite)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not create invite."))
      .finally(() => setBusy(false))
  }

  useEffect(() => {
    if (!open || !member) return
    setInvite(null)
    setError(null)
    setCopied(false)
    setCopiedLink(false)
    generate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, member])

  // QR payload the claim flow understands (token + human-typable code).
  const payload = invite
    ? JSON.stringify({ app: "lumora", token: invite.token, code: invite.code })
    : ""

  const copyCode = async () => {
    if (!invite) return
    try {
      await navigator.clipboard.writeText(invite.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch { /* ignore */ }
  }

  const copyLink = async () => {
    if (!invite) return
    // Deep-link that the mobile app can intercept; falls back to a web URL.
    const link = `lumora://invite/${invite.token}`
    try {
      await navigator.clipboard.writeText(link)
      setCopiedLink(true)
      setTimeout(() => setCopiedLink(false), 1800)
    } catch { /* ignore */ }
  }

  const handleCancel = async () => {
    if (!invite || !member) return
    setCancelling(true)
    try {
      await cancelInvite(invite.id, member.id)
      setInvite(null)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel invite.")
    } finally {
      setCancelling(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} title={`Invite ${member?.name ?? "member"}`}>
      <div className="flex flex-col items-center text-center">
        {busy ? (
          <SkeletonBlock className="size-56 rounded-xl" label="Making an invite code" />
        ) : error ? (
          <div className="w-full space-y-3">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>
            <button
              type="button"
              onClick={generate}
              className="flex w-full items-center justify-center gap-2 rounded-md border border-border py-3 text-sm font-semibold"
            >
              <RefreshCw className="size-4" />
              Try again
            </button>
          </div>
        ) : invite ? (
          <>
            <p className="mb-4 max-w-xs text-pretty text-sm text-muted-foreground">
              Have{" "}
              <span className="font-semibold text-foreground">{member?.name}</span> open Solora on
              their phone, tap{" "}
              <span className="font-semibold text-foreground">I have an invite</span>, and scan the
              code below to create their profile.
            </p>

            {/* QR code */}
            <div className="rounded-md border border-border bg-white p-3">
              <QrCode value={payload} size={192} />
            </div>

            {/* Manual code */}
            <div className="mt-4 w-full">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Or enter this code manually
              </p>
              <button
                type="button"
                onClick={copyCode}
                className="mt-1.5 flex w-full items-center justify-center gap-2 rounded-md bg-secondary py-3 text-xl font-bold tracking-widest text-foreground transition-colors hover:bg-secondary/80"
              >
                {invite.code}
                {copied ? (
                  <Check className="size-4 text-member-green" />
                ) : (
                  <Copy className="size-4 text-muted-foreground" />
                )}
              </button>
            </div>

            {/* Copy link */}
            <button
              type="button"
              onClick={copyLink}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-md border border-border py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
            >
              {copiedLink ? (
                <>
                  <Check className="size-4 text-member-green" />
                  Link copied
                </>
              ) : (
                <>
                  <Copy className="size-4" />
                  Copy invite link
                </>
              )}
            </button>

            <p className="mt-2 text-xs text-muted-foreground">
              Expires in 7 days &middot; code is single-use
            </p>

            {/* Refresh / Cancel */}
            <div className="mt-4 flex w-full gap-2">
              <button
                type="button"
                onClick={generate}
                disabled={busy}
                className="flex flex-1 items-center justify-center gap-2 rounded-md border border-border py-2.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
              >
                <RefreshCw className="size-4" />
                New code
              </button>
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive/10 py-2.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/15 disabled:opacity-50"
              >
                {cancelling ? (
                  <OrbitLoader size={16} />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Cancel invite
              </button>
            </div>
          </>
        ) : null}
      </div>
    </BottomSheet>
  )
}

// ─── Member status badge ────────────────────────────────────────────────────
function MemberStatusBadge({ member }: { member: Member }) {
  if (member.pending) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-member-amber/15 px-2 py-0.5 text-[0.7rem] font-semibold text-member-amber">
        <Send className="size-2.5" />
        Invite sent
      </span>
    )
  }
  if (member.userId || member.account) {
    return (
      <span className="flex items-center gap-1 rounded-full bg-member-green/15 px-2 py-0.5 text-[0.7rem] font-semibold text-member-green">
        <UserCheck className="size-2.5" />
        Linked
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[0.7rem] font-semibold text-muted-foreground">
      <Unplug className="size-2.5" />
      Not linked
    </span>
  )
}

// ─── Per-member action sheet ─────────────────────────────────────────────────
function MemberActionSheet({
  open,
  member,
  onClose,
  onEdit,
  onInvite,
  onDelete,
}: {
  open: boolean
  member: Member | null
  onClose: () => void
  onEdit: () => void
  onInvite: () => void
  onDelete: () => void
}) {
  if (!member) return null
  const age = calculateAge(member.dob)
  return (
    <BottomSheet open={open} onClose={onClose} title={member.name}>
      <div className="space-y-3">
        {/* Summary card */}
        <div className="flex items-center gap-4 rounded-md bg-secondary/50 px-4 py-3">
          <MemberAvatar member={member} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold">{member.name}</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-card px-2 py-0.5 text-xs font-semibold text-muted-foreground">
                {roleLabels[member.role]}
              </span>
              {age !== null && (
                <span className="text-xs text-muted-foreground">{age} yrs</span>
              )}
              <MemberStatusBadge member={member} />
            </div>
          </div>
        </div>

        {/* Actions */}
        <button
          type="button"
          onClick={onEdit}
          className="flex w-full items-center gap-3 rounded-md bg-secondary/50 px-4 py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-card">
            <User className="size-4 text-primary" />
          </span>
          Edit profile
          <ChevronRight className="ml-auto size-4 text-muted-foreground" />
        </button>

        <button
          type="button"
          onClick={onInvite}
          className="flex w-full items-center gap-3 rounded-md bg-secondary/50 px-4 py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-card">
            <QrCodeIcon className="size-4 text-primary" />
          </span>
          {member.pending ? "Resend invite" : "Invite to app"}
          <ChevronRight className="ml-auto size-4 text-muted-foreground" />
        </button>

        <button
          type="button"
          onClick={onDelete}
          className="flex w-full items-center gap-3 rounded-md bg-destructive/8 px-4 py-3.5 text-sm font-semibold text-destructive transition-colors hover:bg-destructive/12"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-destructive/10">
            <Trash2 className="size-4 text-destructive" />
          </span>
          Remove member
        </button>
      </div>
    </BottomSheet>
  )
}

// ─── Full Members section ─────────────────────────────────────────────────────
function FamilyMembersSection() {
  const { members, deleteMember, can, addMember } = useStore()
  const canManageMembers = can("members")

  // Sheet states
  const [actionMember, setActionMember] = useState<Member | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editTarget, setEditTarget] = useState<Member | null>(null)
  const [inviteTarget, setInviteTarget] = useState<Member | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<Member | null>(null)

  // Add-new sheet
  const [addOpen, setAddOpen] = useState(false)

  // Quick-invite (create + invite in one flow)
  const [quickOpen, setQuickOpen] = useState(false)
  const [quickName, setQuickName] = useState("")
  const [quickRole, setQuickRole] = useState<MemberRole>("adult")
  const [quickColor, setQuickColor] = useState<MemberColor>("blue")
  const [quickBusy, setQuickBusy] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)
  const [quickInviteAfter, setQuickInviteAfter] = useState<Member | null>(null)

  const people = members.filter((m) => m.id !== "family")

  // Open action sheet for a card
  const openAction = (m: Member) => {
    if (!canManageMembers) return
    setActionMember(m)
  }

  // From action sheet → edit
  const goEdit = () => {
    setEditTarget(actionMember)
    setActionMember(null)
    setEditOpen(true)
  }

  // From action sheet → invite
  const goInvite = () => {
    setInviteTarget(actionMember)
    setActionMember(null)
  }

  // From action sheet → delete confirm
  const goDelete = () => {
    setConfirmDelete(actionMember)
    setActionMember(null)
  }

  // Quick-invite submit
  const submitQuickInvite = async () => {
    const name = quickName.trim()
    if (!name) return
    setQuickBusy(true)
    setQuickError(null)
    try {
      const { api: localApi } = await import("@/lib/api")
      const created = await localApi.createMember({
        name,
        color: quickColor,
        role: quickRole,
        permissions: [],
      })
      const member: Member = {
        id: created.id,
        name: created.name,
        initial: created.name.charAt(0).toUpperCase(),
        color: created.color,
        role: created.role,
        dob: created.dob,
        account: created.account,
        permissions: created.permissions,
        pending: false,
      }
      addMember(member)
      setQuickOpen(false)
      setQuickName("")
      setQuickInviteAfter(member)
    } catch (e) {
      setQuickError(e instanceof Error ? e.message : "Could not add member.")
    } finally {
      setQuickBusy(false)
    }
  }

  return (
    <section className="space-y-3">
      {/* Section header */}
      <div className="flex items-center justify-between px-1">
        <h2 className="os-label">Family Members</h2>
        <span className="text-xs text-muted-foreground">{people.length} {people.length === 1 ? "person" : "people"}</span>
      </div>

      {/* Member grid */}
      {people.length === 0 ? (
        /* Empty state */
        <div className="flex flex-col items-center gap-3 rounded-lg border-2 border-dashed border-border bg-card/50 py-12">
          <span className="flex size-14 items-center justify-center rounded-full bg-secondary">
            <UserPlus className="size-6 text-muted-foreground" />
          </span>
          <div className="text-center">
            <p className="text-sm font-semibold">No members yet</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Add people so they can be assigned tasks, events and more.</p>
          </div>
          {canManageMembers && (
            <button
              type="button"
              onClick={() => { setEditTarget(null); setAddOpen(true) }}
              className="mt-1 flex items-center gap-2 rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground"
            >
              <UserPlus className="size-4" />
              Add first member
            </button>
          )}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {people.map((m) => {
            const age = calculateAge(m.dob)
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => openAction(m)}
                disabled={!canManageMembers}
                className="group relative flex w-36 shrink-0 flex-col overflow-hidden rounded-md border border-hairline bg-card transition-transform active:scale-95 disabled:cursor-default"
              >
                {/* Color accent bar */}
                <div className={cn("h-1.5 w-full", memberBg[m.color])} />

                <div className="flex flex-col items-center gap-2 px-3 pb-4 pt-3">
                  <MemberAvatar member={m} size="lg" />
                  <div className="w-full text-center">
                    <p className="truncate text-sm font-semibold leading-tight">{m.name}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {roleLabels[m.role]}{age !== null ? ` · ${age} yrs` : ""}
                    </p>
                  </div>
                  <MemberStatusBadge member={m} />
                </div>

                {canManageMembers && (
                  <span className="absolute right-2 top-3 opacity-0 transition-opacity group-hover:opacity-100">
                    <ChevronRight className="size-3.5 text-muted-foreground" />
                  </span>
                )}
              </button>
            )
          })}

          {/* Add card — always last in row */}
          {canManageMembers && (
            <button
              type="button"
              onClick={() => { setEditTarget(null); setAddOpen(true) }}
              className="flex w-36 shrink-0 flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border bg-card/50 py-8 transition-colors hover:bg-card"
            >
              <span className="flex size-10 items-center justify-center rounded-full bg-secondary">
                <UserPlus className="size-5 text-muted-foreground" />
              </span>
              <span className="text-xs font-semibold text-muted-foreground">Add member</span>
            </button>
          )}
        </div>
      )}

      {/* Bottom CTAs */}
      {canManageMembers && people.length > 0 && (
        <button
          type="button"
          onClick={() => { setQuickOpen(true); setQuickError(null) }}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-border bg-card py-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          <QrCodeIcon className="size-4 text-primary" />
          Invite someone to join
        </button>
      )}

      {/* Per-member action sheet */}
      <MemberActionSheet
        open={!!actionMember}
        member={actionMember}
        onClose={() => setActionMember(null)}
        onEdit={goEdit}
        onInvite={goInvite}
        onDelete={goDelete}
      />

      {/* Edit sheet (also used for Add when editTarget is null) */}
      <MemberSheet
        open={editOpen || addOpen}
        member={editOpen ? editTarget : null}
        onClose={() => { setEditOpen(false); setAddOpen(false) }}
        onDelete={
          editOpen && editTarget && canManageMembers
            ? () => { setConfirmDelete(editTarget); setEditOpen(false) }
            : undefined
        }
        onInvite={
          editOpen && editTarget
            ? () => { setInviteTarget(editTarget); setEditOpen(false) }
            : undefined
        }
      />

      {/* Invite QR sheet */}
      <InviteSheet
        open={!!inviteTarget || !!quickInviteAfter}
        member={inviteTarget ?? quickInviteAfter}
        onClose={() => { setInviteTarget(null); setQuickInviteAfter(null) }}
      />

      {/* Quick-invite sheet (name → invite) */}
      <BottomSheet
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        title="Invite someone to join"
        footer={
          <button
            type="button"
            onClick={submitQuickInvite}
            disabled={!quickName.trim() || quickBusy}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40"
          >
            {quickBusy ? <OrbitLoader size={16} /> : <QrCodeIcon className="size-4" />}
            Create &amp; get invite code
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Enter their name and role. You&apos;ll get a QR code and a manual code they scan on their
            phone to set up their own account.
          </p>
          <Field label="Name">
            <input
              className={inputClass}
              value={quickName}
              onChange={(e) => setQuickName(e.target.value)}
              placeholder="Full name"
              autoFocus
            />
          </Field>
          <Field label="Role">
            <div className="grid grid-cols-4 gap-1.5">
              {roleOptions.map((r) => {
                const active = quickRole === r
                return (
                  <button key={r} type="button" onClick={() => setQuickRole(r)} aria-pressed={active}
                    className={cn("rounded-md py-2 text-xs font-semibold transition-colors",
                      active ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground")}
                  >
                    {roleLabels[r]}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="Color">
            <div className="flex gap-2.5">
              {colorOptions.map((c) => {
                const active = quickColor === c
                return (
                  <button key={c} type="button" onClick={() => setQuickColor(c)} aria-label={c} aria-pressed={active}
                    className={cn("size-11 rounded-full transition-transform", memberBg[c],
                      active ? "ring-2 ring-foreground ring-offset-2 ring-offset-card" : "hover:scale-105")}
                  />
                )
              })}
            </div>
          </Field>
          {quickError && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{quickError}</p>
          )}
        </div>
      </BottomSheet>

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!confirmDelete}
        title={`Remove ${confirmDelete?.name ?? "member"}?`}
        message="This removes the member and unlinks their account. This cannot be undone."
        confirmLabel="Remove"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          if (confirmDelete) deleteMember(confirmDelete.id)
          setConfirmDelete(null)
        }}
      />
    </section>
  )
}

/**
 * Two-step factory reset confirmation dialog.
 *
 * Step 1: Warn the user about what will be deleted and ask them to continue.
 * Step 2: Require them to type "RESET" before the action is enabled.
 */
function FactoryResetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [typed, setTyped] = useState("")
  const [busy, setBusy] = useState(false)

  // Reset internal state whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setStep(1)
      setTyped("")
      setBusy(false)
    }
  }, [open])

  const confirmed = typed.trim().toUpperCase() === "RESET"

  const handleReset = async () => {
    if (!confirmed || busy) return
    setBusy(true)
    await factoryReset()
    // factoryReset() reloads / exits — this line only runs in unexpected cases.
    setBusy(false)
    onClose()
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="Factory Reset">
      {step === 1 ? (
        <div className="space-y-4">
          {/* Warning banner */}
          <div className="flex items-start gap-3 rounded-md bg-destructive/10 p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-destructive">This cannot be undone</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                A factory reset permanently deletes everything stored on this device.
              </p>
            </div>
          </div>

          {/* What gets deleted */}
          <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline">
            {[
              { icon: User, label: "All family member profiles" },
              { icon: Lock, label: "Account & authentication data" },
              { icon: Wifi, label: "Saved Wi-Fi networks" },
              { icon: ScrollText, label: "Activity logs & notifications" },
              { icon: Trash2, label: "App preferences & settings" },
            ].map(({ icon: Icon, label }) => (
              <div key={label} className="flex items-center gap-3 px-4 py-2.5">
                <Icon className="size-4 shrink-0 text-destructive/70" />
                <span className="text-sm text-foreground">{label}</span>
              </div>
            ))}
          </div>

          <p className="text-xs text-muted-foreground">
            The device will restart and return to the initial setup wizard.
          </p>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-md border border-border bg-card py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setStep(2)}
              className="flex-1 rounded-md bg-destructive py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-md bg-destructive/10 p-4">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
            <p className="text-sm font-semibold text-destructive">
              All data will be permanently erased. This device will be reset to factory defaults.
            </p>
          </div>

          <div>
            <label htmlFor="reset-confirm" className="mb-2 block text-sm font-medium">
              Type <span className="font-mono font-bold tracking-wider text-destructive">RESET</span> to confirm
            </label>
            <input
              id="reset-confirm"
              type="text"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="RESET"
              className="w-full rounded-md border border-border bg-background px-3 py-3 text-sm font-mono tracking-wider outline-none transition-colors focus:border-destructive"
            />
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
              className="flex-1 rounded-md border border-border bg-card py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={!confirmed || busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-md bg-destructive py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              {busy ? (
                <>
                  <OrbitLoader size={16} />
                  Resetting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Factory Reset
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </BottomSheet>
  )
}

// ─── WiFi ────────────────────────────────────────────────────────────────────

function SignalBars({ signal }: { signal: number }) {
  const pct = Math.round(signal)
  const color = pct >= 70 ? "text-member-green" : pct >= 40 ? "text-member-amber" : "text-destructive"
  return (
    <span className={cn("text-[0.75rem] font-semibold tabular-nums", color)}>
      {pct}%
    </span>
  )
}

function WifiSection() {
  const [currentSsid, setCurrentSsid] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [networks, setNetworks] = useState<WifiNetwork[]>([])
  const [scanning, setScanning] = useState(false)
  const [connecting, setConnecting] = useState<string | null>(null)
  const [passwordFor, setPasswordFor] = useState<WifiNetwork | null>(null)
  const [password, setPassword] = useState("")
  const [connectError, setConnectError] = useState<string | null>(null)

  useEffect(() => {
    currentNetwork().then(setCurrentSsid).catch(() => null)
  }, [])

  const scan = async () => {
    setScanning(true)
    setConnectError(null)
    try {
      const nets = await scanNetworks()
      setNetworks(nets)
    } catch (err) {
      setNetworks([])
      setConnectError(err instanceof Error ? err.message : "Scan failed — check WiFi hardware")
    } finally {
      setScanning(false)
    }
  }

  const openSheet = () => {
    setSheetOpen(true)
    setPasswordFor(null)
    setPassword("")
    setConnectError(null)
    void scan()
  }

  const doConnect = async (ssid: string, pwd?: string) => {
    setConnecting(ssid)
    setConnectError(null)
    try {
      const ok = await wifiConnect(ssid, pwd)
      if (ok) {
        setCurrentSsid(ssid)
        setSheetOpen(false)
        setPasswordFor(null)
        setPassword("")
        kioskToast.success(`Connected to ${ssid}`)
      } else {
        setConnectError("Connection failed — wrong password?")
      }
    } catch (e) {
      setConnectError(e instanceof Error ? e.message : "Connection failed")
    } finally {
      setConnecting(null)
    }
  }

  const handleNetworkTap = (net: WifiNetwork) => {
    if (net.connected) return
    if (needsPassword(net.security)) {
      setPasswordFor(net)
      setPassword("")
      setConnectError(null)
    } else {
      void doConnect(net.ssid)
    }
  }

  return (
    <section>
      <h2 className="os-label px-1 pb-4">WiFi</h2>
      <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-card">
        <ActionRow
          icon={Wifi}
          label="Network"
          description={currentSsid ?? "Not connected"}
          onClick={openSheet}
        />
      </div>

      {/* Network picker */}
      <BottomSheet open={sheetOpen && !passwordFor} onClose={() => setSheetOpen(false)} title="WiFi Network">
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{networks.length} networks found</p>
          <button
            type="button"
            onClick={() => void scan()}
            disabled={scanning}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-40"
          >
            {scanning ? <OrbitLoader size={14} /> : <RefreshCw className="size-3.5" />}
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>

        {connectError ? (
          <p className="mb-3 rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">{connectError}</p>
        ) : null}

        <ul className="max-h-[55vh] divide-y divide-hairline overflow-y-auto overscroll-contain rounded-md bg-background">
          {scanning && networks.length === 0 ? (
            <li className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <OrbitLoader size={16} />
              Scanning…
            </li>
          ) : networks.length === 0 ? (
            <li className="px-4 py-10 text-center text-sm text-muted-foreground">No networks found</li>
          ) : (
            networks.map((net) => {
              const isConnecting = connecting === net.ssid
              return (
                <li key={net.ssid}>
                  <button
                    type="button"
                    onClick={() => handleNetworkTap(net)}
                    disabled={!!connecting}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50 disabled:opacity-60"
                  >
                    <Wifi className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{net.ssid}</span>
                      <span className="block text-xs text-muted-foreground">
                        {net.security === "open" ? "Open" : net.security.toUpperCase()}
                      </span>
                    </span>
                    {isConnecting ? (
                      <OrbitLoader size={16} className="shrink-0 text-muted-foreground" />
                    ) : net.connected ? (
                      <Check className="size-4 shrink-0 text-member-green" />
                    ) : (
                      <SignalBars signal={net.signal} />
                    )}
                  </button>
                </li>
              )
            })
          )}
        </ul>
      </BottomSheet>

      {/* Password entry */}
      <BottomSheet
        open={!!passwordFor}
        onClose={() => { setPasswordFor(null); setConnectError(null) }}
        title={`Connect to ${passwordFor?.ssid ?? ""}`}
        footer={
          <button
            type="button"
            onClick={() => passwordFor && void doConnect(passwordFor.ssid, password)}
            disabled={!password.trim() || !!connecting}
            className="flex w-full items-center justify-center gap-2 rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground disabled:opacity-40"
          >
            {connecting ? <OrbitLoader size={16} /> : null}
            {connecting ? "Connecting…" : "Connect"}
          </button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Enter the password for <span className="font-semibold text-foreground">{passwordFor?.ssid}</span>.
          </p>
          <input
            type="password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password.trim() && !connecting && passwordFor) {
                void doConnect(passwordFor.ssid, password)
              }
            }}
            placeholder="Password"
            className="w-full rounded-md border border-border bg-background px-3 py-3 text-sm outline-none transition-colors focus:border-primary"
          />
          {connectError ? (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">{connectError}</p>
          ) : null}
        </div>
      </BottomSheet>
    </section>
  )
}

// ─── Language & Region ────────────────────────────────────────────────────────

/**
 * Full list of supported OS locales.
 *
 * On a real kiosk each entry maps to a POSIX locale that `localectl set-locale`
 * understands. The Rust command converts BCP-47 codes (e.g. "en-US") to the
 * required POSIX form (e.g. "en_US.UTF-8") before invoking localectl.
 *
 * This changes the OPERATING SYSTEM language — not just the app — so
 * shell commands, system dialogs, and the display manager all switch locale
 * after the next session/reboot.
 */
const SUPPORTED_LANGUAGES = [
  { code: "en-US", label: "English (US)", native: "English" },
  { code: "en-GB", label: "English (UK)", native: "English (UK)" },
  { code: "es-ES", label: "Spanish", native: "Español" },
  { code: "es-MX", label: "Spanish (Mexico)", native: "Español (MX)" },
  { code: "fr-FR", label: "French", native: "Français" },
  { code: "de-DE", label: "German", native: "Deutsch" },
  { code: "it-IT", label: "Italian", native: "Italiano" },
  { code: "pt-BR", label: "Portuguese (Brazil)", native: "Português" },
  { code: "pt-PT", label: "Portuguese (Portugal)", native: "Português (PT)" },
  { code: "nl-NL", label: "Dutch", native: "Nederlands" },
  { code: "sv-SE", label: "Swedish", native: "Svenska" },
  { code: "no-NO", label: "Norwegian", native: "Norsk" },
  { code: "da-DK", label: "Danish", native: "Dansk" },
  { code: "fi-FI", label: "Finnish", native: "Suomi" },
  { code: "pl-PL", label: "Polish", native: "Polski" },
  { code: "cs-CZ", label: "Czech", native: "Čeština" },
  { code: "hu-HU", label: "Hungarian", native: "Magyar" },
  { code: "ru-RU", label: "Russian", native: "Русский" },
  { code: "uk-UA", label: "Ukrainian", native: "Українська" },
  { code: "tr-TR", label: "Turkish", native: "Türkçe" },
  { code: "el-GR", label: "Greek", native: "Ελληνικά" },
  { code: "ro-RO", label: "Romanian", native: "Română" },
  { code: "ja-JP", label: "Japanese", native: "日本語" },
  { code: "zh-CN", label: "Chinese (Simplified)", native: "中文 (简体)" },
  { code: "zh-TW", label: "Chinese (Traditional)", native: "中文 (繁體)" },
  { code: "ko-KR", label: "Korean", native: "한국어" },
  { code: "ar-SA", label: "Arabic", native: "العربية" },
  { code: "he-IL", label: "Hebrew", native: "עברית" },
  { code: "hi-IN", label: "Hindi", native: "हिंदी" },
  { code: "th-TH", label: "Thai", native: "ภาษาไทย" },
  { code: "vi-VN", label: "Vietnamese", native: "Tiếng Việt" },
  { code: "id-ID", label: "Indonesian", native: "Bahasa Indonesia" },
  { code: "ms-MY", label: "Malay", native: "Bahasa Melayu" },
]

/**
 * A subset of common IANA timezone identifiers.
 * Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
 */
const SUPPORTED_TIMEZONES = [
  { tz: "UTC", label: "UTC (Coordinated Universal Time)" },
  { tz: "America/New_York", label: "Eastern Time — New York" },
  { tz: "America/Chicago", label: "Central Time — Chicago" },
  { tz: "America/Denver", label: "Mountain Time — Denver" },
  { tz: "America/Phoenix", label: "Mountain Time — Phoenix (no DST)" },
  { tz: "America/Los_Angeles", label: "Pacific Time — Los Angeles" },
  { tz: "America/Anchorage", label: "Alaska Time — Anchorage" },
  { tz: "Pacific/Honolulu", label: "Hawaii Time — Honolulu" },
  { tz: "America/Toronto", label: "Eastern Time — Toronto" },
  { tz: "America/Vancouver", label: "Pacific Time — Vancouver" },
  { tz: "America/Sao_Paulo", label: "Brasília — São Paulo" },
  { tz: "America/Argentina/Buenos_Aires", label: "Argentina — Buenos Aires" },
  { tz: "America/Mexico_City", label: "Central Time — Mexico City" },
  { tz: "Europe/London", label: "GMT/BST — London" },
  { tz: "Europe/Paris", label: "Central European — Paris" },
  { tz: "Europe/Berlin", label: "Central European — Berlin" },
  { tz: "Europe/Madrid", label: "Central European — Madrid" },
  { tz: "Europe/Rome", label: "Central European — Rome" },
  { tz: "Europe/Amsterdam", label: "Central European — Amsterdam" },
  { tz: "Europe/Stockholm", label: "Central European — Stockholm" },
  { tz: "Europe/Moscow", label: "Moscow Time — Moscow" },
  { tz: "Europe/Istanbul", label: "Turkey Time — Istanbul" },
  { tz: "Europe/Warsaw", label: "Central European — Warsaw" },
  { tz: "Europe/Zurich", label: "Central European — Zurich" },
  { tz: "Africa/Cairo", label: "Egypt Time — Cairo" },
  { tz: "Africa/Nairobi", label: "East Africa — Nairobi" },
  { tz: "Africa/Johannesburg", label: "South Africa — Johannesburg" },
  { tz: "Africa/Lagos", label: "West Africa — Lagos" },
  { tz: "Asia/Dubai", label: "Gulf Time — Dubai" },
  { tz: "Asia/Riyadh", label: "Arabia Time — Riyadh" },
  { tz: "Asia/Kolkata", label: "India Time — Kolkata" },
  { tz: "Asia/Dhaka", label: "Bangladesh — Dhaka" },
  { tz: "Asia/Bangkok", label: "Indochina — Bangkok" },
  { tz: "Asia/Singapore", label: "Singapore Time" },
  { tz: "Asia/Shanghai", label: "China Time — Shanghai" },
  { tz: "Asia/Tokyo", label: "Japan Time — Tokyo" },
  { tz: "Asia/Seoul", label: "Korea Time — Seoul" },
  { tz: "Asia/Hong_Kong", label: "Hong Kong Time" },
  { tz: "Asia/Jakarta", label: "Western Indonesia — Jakarta" },
  { tz: "Asia/Karachi", label: "Pakistan — Karachi" },
  { tz: "Asia/Tehran", label: "Iran Time — Tehran" },
  { tz: "Australia/Sydney", label: "Eastern Australia — Sydney" },
  { tz: "Australia/Melbourne", label: "Eastern Australia — Melbourne" },
  { tz: "Australia/Perth", label: "Western Australia — Perth" },
  { tz: "Pacific/Auckland", label: "New Zealand — Auckland" },
  { tz: "Pacific/Fiji", label: "Fiji Time" },
]

const ORIENTATION_OPTIONS: { value: ScreenOrientation; label: string; description: string }[] = [
  { value: "normal", label: "Landscape", description: "Standard horizontal" },
  { value: "left", label: "Portrait (left)", description: "90° counter-clockwise" },
  { value: "right", label: "Portrait (right)", description: "90° clockwise" },
  { value: "inverted", label: "Landscape (flipped)", description: "Upside-down" },
]

function LanguageRegionSection({ initialOrientation }: { initialOrientation?: string | null }) {
  const [currentLang, setCurrentLang] = useState<string | null>(null)
  const [currentTz, setCurrentTz] = useState<string | null>(null)
  const [currentOrientation, setCurrentOrientation] = useState<ScreenOrientation>(
    (initialOrientation as ScreenOrientation | null | undefined) ?? "normal",
  )
  const [langSheetOpen, setLangSheetOpen] = useState(false)
  const [tzSheetOpen, setTzSheetOpen] = useState(false)
  const [orientationSheetOpen, setOrientationSheetOpen] = useState(false)
  const [applying, setApplying] = useState(false)
  const [langSearch, setLangSearch] = useState("")
  const [tzSearch, setTzSearch] = useState("")

  useEffect(() => {
    getLanguage().then((r) => setCurrentLang(r.lang))
    getTimezone().then((r) => setCurrentTz(r.timezone))
  }, [])

  const activeLang = SUPPORTED_LANGUAGES.find(
    (l) => l.code === currentLang || l.code.replace("-", "_") === currentLang?.split(".")[0],
  )
  const activeTz = SUPPORTED_TIMEZONES.find((t) => t.tz === currentTz)

  const applyLanguage = async (code: string) => {
    setApplying(true)
    setLangSheetOpen(false)
    try {
      const ok = await setLanguage(code)
      if (ok) {
        setCurrentLang(code)
        kioskToast.success("OS language updated — takes effect after a restart")
      } else {
        kioskToast.error("Could not apply language — check system permissions")
      }
    } catch {
      kioskToast.error("Could not apply language")
    } finally {
      setApplying(false)
    }
  }

  const applyTimezone = async (tz: string) => {
    setApplying(true)
    setTzSheetOpen(false)
    try {
      const ok = await setTimezone(tz)
      if (ok) {
        setCurrentTz(tz)
        void saveTimezone(tz).catch(() => {})
        kioskToast.success("Timezone updated — takes effect immediately")
      } else {
        kioskToast.error("Could not apply timezone — check system permissions")
      }
    } catch {
      kioskToast.error("Could not apply timezone")
    } finally {
      setApplying(false)
    }
  }

  const applyOrientationSetting = async (rotation: ScreenOrientation) => {
    setApplying(true)
    setOrientationSheetOpen(false)
    try {
      if (isHubDevice()) {
        const ok = await setOrientation(rotation)
        if (ok) {
          setCurrentOrientation(rotation)
          await patchDeviceState({ orientation: rotation })
          kioskToast.success("Screen rotation updated")
        } else {
          kioskToast.error("Could not apply rotation — check display connection")
        }
      } else {
        await sendHubCommand({ type: "set_orientation", orientation: rotation })
        setCurrentOrientation(rotation)
        await patchDeviceState({ orientation: rotation })
        kioskToast.success("Orientation command sent to hub")
      }
    } catch {
      kioskToast.error("Could not apply rotation")
    } finally {
      setApplying(false)
    }
  }

  const filteredLangs = langSearch.trim()
    ? SUPPORTED_LANGUAGES.filter(
      (l) =>
        l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
        l.native.toLowerCase().includes(langSearch.toLowerCase()) ||
        l.code.toLowerCase().includes(langSearch.toLowerCase()),
    )
    : SUPPORTED_LANGUAGES

  const filteredTzs = tzSearch.trim()
    ? SUPPORTED_TIMEZONES.filter(
      (t) =>
        t.label.toLowerCase().includes(tzSearch.toLowerCase()) ||
        t.tz.toLowerCase().includes(tzSearch.toLowerCase()),
    )
    : SUPPORTED_TIMEZONES

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Language & Region</h2>

      {/* OS-level explanation banner */}
      <div className="mb-3 flex items-start gap-3 rounded-md border border-hairline bg-card px-4 py-3">
        <Globe className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs text-muted-foreground leading-relaxed">
          These settings change the <span className="font-semibold text-foreground">operating system language</span> via{" "}
          <span className="font-mono text-[0.75rem]">localectl</span> and timezone via{" "}
          <span className="font-mono text-[0.75rem]">timedatectl</span> — affecting the whole hub, not just the app.
          Language changes take effect after a restart; timezone changes are immediate.
        </p>
      </div>

      <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-card">
        {/* Language */}
        <ActionRow
          icon={Globe}
          label="Display Language"
          description={activeLang ? `${activeLang.label} — ${activeLang.native}` : (currentLang ?? "Detecting…")}
          onClick={() => { setLangSearch(""); setLangSheetOpen(true) }}
          trailing={
            applying ? (
              <OrbitLoader size={16} className="text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )
          }
        />
        {/* Timezone */}
        <ActionRow
          icon={Clock}
          label="Time Zone"
          description={activeTz ? activeTz.label : (currentTz ?? "Detecting…")}
          onClick={() => { setTzSearch(""); setTzSheetOpen(true) }}
          trailing={
            applying ? (
              <OrbitLoader size={16} className="text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )
          }
        />
        {/* Screen orientation */}
        <ActionRow
          icon={RotateCcw}
          label="Screen Orientation"
          description={ORIENTATION_OPTIONS.find((o) => o.value === currentOrientation)?.label ?? "Landscape"}
          onClick={() => setOrientationSheetOpen(true)}
          trailing={
            applying ? (
              <OrbitLoader size={16} className="text-muted-foreground" />
            ) : (
              <ChevronRight className="size-4 text-muted-foreground" />
            )
          }
        />
      </div>

      {/* Language picker sheet */}
      <BottomSheet open={langSheetOpen} onClose={() => setLangSheetOpen(false)} title="Display Language">
        <div className="mb-3">
          <input
            type="search"
            placeholder="Search languages…"
            value={langSearch}
            onChange={(e) => setLangSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>
        <ul className="max-h-[55vh] divide-y divide-hairline overflow-y-auto overscroll-contain rounded-md bg-background">
          {filteredLangs.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">No languages match</li>
          ) : (
            filteredLangs.map((lang) => {
              const active = lang.code === currentLang || lang.code.replace("-", "_") === currentLang?.split(".")[0]
              return (
                <li key={lang.code}>
                  <button
                    type="button"
                    onClick={() => void applyLanguage(lang.code)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{lang.native}</span>
                      <span className="block text-xs text-muted-foreground">{lang.label}</span>
                    </span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-member-green" />
                    ) : (
                      <span className="w-4" />
                    )}
                  </button>
                </li>
              )
            })
          )}
        </ul>
        <p className="mt-3 text-center text-[0.75rem] text-muted-foreground">
          Runs{" "}
          <span className="font-mono">localectl set-locale LANG=xx_XX.UTF-8</span>{" "}
          on the hub
        </p>
      </BottomSheet>

      {/* Timezone picker sheet */}
      <BottomSheet open={tzSheetOpen} onClose={() => setTzSheetOpen(false)} title="Time Zone">
        <div className="mb-3">
          <input
            type="search"
            placeholder="Search timezones…"
            value={tzSearch}
            onChange={(e) => setTzSearch(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>
        <ul className="max-h-[55vh] divide-y divide-hairline overflow-y-auto overscroll-contain rounded-md bg-background">
          {filteredTzs.length === 0 ? (
            <li className="px-4 py-8 text-center text-sm text-muted-foreground">No timezones match</li>
          ) : (
            filteredTzs.map((entry) => {
              const active = entry.tz === currentTz
              return (
                <li key={entry.tz}>
                  <button
                    type="button"
                    onClick={() => void applyTimezone(entry.tz)}
                    className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{entry.label}</span>
                      <span className="block text-xs font-mono text-muted-foreground">{entry.tz}</span>
                    </span>
                    {active ? (
                      <Check className="size-4 shrink-0 text-member-green" />
                    ) : (
                      <span className="w-4" />
                    )}
                  </button>
                </li>
              )
            })
          )}
        </ul>
        <p className="mt-3 text-center text-[0.75rem] text-muted-foreground">
          Runs{" "}
          <span className="font-mono">timedatectl set-timezone</span>{" "}
          on the hub
        </p>
      </BottomSheet>

      {/* Orientation picker sheet */}
      <BottomSheet open={orientationSheetOpen} onClose={() => setOrientationSheetOpen(false)} title="Screen Orientation">
        <ul className="divide-y divide-hairline overflow-hidden rounded-md bg-background">
          {ORIENTATION_OPTIONS.map((opt) => {
            const active = opt.value === currentOrientation
            return (
              <li key={opt.value}>
                <button
                  type="button"
                  onClick={() => void applyOrientationSetting(opt.value)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary/50"
                >
                  <RotateCcw className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{opt.label}</span>
                    <span className="block text-xs text-muted-foreground">{opt.description}</span>
                  </span>
                  {active ? (
                    <Check className="size-4 shrink-0 text-member-green" />
                  ) : (
                    <span className="w-4" />
                  )}
                </button>
              </li>
            )
          })}
        </ul>
        <p className="mt-3 text-center text-[0.75rem] text-muted-foreground">
          Runs <span className="font-mono">xrandr --rotate</span> on the hub
        </p>
      </BottomSheet>
    </section>
  )
}

const IDLE_OPTIONS: { label: string; value: number | null }[] = [
  { label: "Off", value: null },
  { label: "1 min", value: 1 },
  { label: "2 min", value: 2 },
  { label: "5 min", value: 5 },
  { label: "10 min", value: 10 },
  { label: "15 min", value: 15 },
  { label: "30 min", value: 30 },
]

function SlideshowSection({ initialIdleMins }: { initialIdleMins: number | null }) {
  const [current, setCurrent] = useState<number | null>(initialIdleMins)
  const [saving, setSaving] = useState(false)

  const apply = async (value: number | null) => {
    setCurrent(value)
    setSaving(true)
    try {
      await patchDeviceState({ slideshowIdleMins: value })
      kioskToast.success(value === null ? "Slideshow disabled" : `Slideshow starts after ${value} min${value === 1 ? "" : "s"} idle`)
    } catch {
      kioskToast.error("Could not save setting")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Slideshow</h2>
      <div className="overflow-hidden rounded-md border border-hairline bg-card">
        <div className="flex items-center gap-3 px-4 py-4">
          <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
            <Images className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">Photo slideshow</span>
            <span className="block text-xs text-muted-foreground">
              {current === null
                ? "Disabled — tap any time to start manually"
                : `Starts after ${current} min${current === 1 ? "" : "s"} of inactivity`}
            </span>
          </span>
          {saving && <OrbitLoader size={16} className="text-muted-foreground" />}
        </div>
        <div className="flex flex-wrap gap-1.5 border-t border-hairline px-4 py-3">
          {IDLE_OPTIONS.map((opt) => {
            const active = opt.value === current
            return (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => void apply(opt.value)}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:text-foreground",
                )}
              >
                {opt.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-start gap-2.5 border-t border-hairline px-4 py-3">
          <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">
            Tap anywhere on screen to dismiss the slideshow. Requires at least one uploaded photo.
          </p>
        </div>
      </div>
    </section>
  )
}

function CalendarIntegrationSection() {
  const { calendars, addCalendar } = useStore()
  const [importProvider, setImportProvider] = useState<"google" | "microsoft" | null>(null)
  const [icsUrl, setIcsUrl] = useState<string | null>(null)
  const [icsCopied, setIcsCopied] = useState(false)
  const [activityLogOpen, setActivityLogOpen] = useState(false)

  useEffect(() => {
    // Derive household id from the cached session to build ICS token URL.
    const token = tokenStore.get()
    if (!token) return
    try {
      const payload = JSON.parse(atob(token.split(".")[1])) as { householdId?: string }
      if (payload.householdId) {
        fetch(`${LOCAL_API_BASE}/ics/token/${payload.householdId}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((r) => r.json() as Promise<{ token: string; householdId: string; url?: string }>)
          .then(({ token: t, url }) => {
            // The hub's address on the home network; the wall's own address (127.0.0.1) means nothing on another device.
            setIcsUrl(url ?? `${LOCAL_API_BASE}/ics/${t}`)
          })
          .catch(() => null)
      }
    } catch { /* ignore */ }
  }, [])

  const copyIcs = () => {
    if (!icsUrl) return
    navigator.clipboard.writeText(icsUrl).then(() => {
      setIcsCopied(true)
      setTimeout(() => setIcsCopied(false), 2000)
    }).catch(() => null)
  }

  return (
    <section>
      <h2 className="os-label px-1 pb-4">Calendar Integration</h2>
      <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-card">
        <ActionRow
          icon={Globe}
          label="Map Google calendars"
          description="Assign Google calendars to Solora calendars"
          onClick={() => setImportProvider("google")}
        />
        <ActionRow
          icon={Globe}
          label="Map Outlook categories"
          description="Assign Outlook categories to Solora calendars"
          onClick={() => setImportProvider("microsoft")}
        />
        {icsUrl ? (
          <button
            type="button"
            onClick={copyIcs}
            className="flex w-full items-center gap-3 px-4 py-3 text-left"
          >
            <span className="flex size-8 shrink-0 items-center justify-center text-muted-foreground">
              <Link2Off className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">Hub calendar feed</span>
              <span className="block truncate text-xs text-muted-foreground">{icsUrl}</span>
            </span>
            {icsCopied ? (
              <Check className="size-4 shrink-0 text-member-green" />
            ) : (
              <Copy className="size-4 shrink-0 text-muted-foreground" />
            )}
          </button>
        ) : null}
        <ActionRow
          icon={ScrollText}
          label="Activity log"
          description="View recent actions on this hub"
          onClick={() => setActivityLogOpen(true)}
        />
      </div>

      <CalendarImportSheet
        open={importProvider !== null}
        provider={importProvider}
        lumCalendars={calendars}
        onClose={() => setImportProvider(null)}
        onMappingSaved={(newCals) => {
          for (const c of newCals.filter((nc) => !calendars.find((lc) => lc.id === nc.id))) {
            addCalendar({ name: c.name, color: c.color, memberIds: c.memberIds })
          }
          setImportProvider(null)
        }}
      />

      <BottomSheet open={activityLogOpen} onClose={() => setActivityLogOpen(false)} title="Activity Log">
        <ActivityLog onClose={() => setActivityLogOpen(false)} />
      </BottomSheet>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Settings shell — a two-pane layout: a category rail on the left, and only
// the active category's sections on the right. Categories group related
// controls instead of stacking every section in one long scroll.
// ---------------------------------------------------------------------------

type SettingsCategory = "general" | "family" | "display" | "network" | "calendars" | "maintenance" | "account"

const CATEGORY_STORAGE_KEY = "lumora-settings-category"

const categoryMeta: Record<SettingsCategory, { label: string; icon: LucideIcon; description: string }> = {
  general: { label: "General", icon: Tablet, description: "This display, language, time zone and orientation." },
  family: { label: "Family", icon: Users, description: "People in your household, their roles and invites." },
  display: { label: "Display & Sound", icon: Palette, description: "Theme, seasons, brightness, volume and the idle slideshow." },
  network: { label: "Network", icon: Wifi, description: "Wi‑Fi and the Solora cloud connection." },
  calendars: { label: "Calendars", icon: CalendarDays, description: "Imported calendars, ICS feeds and sync activity." },
  maintenance: { label: "Maintenance", icon: Wrench, description: "Updates, activity logs, cache and restarts." },
  account: { label: "Account & Reset", icon: ShieldAlert, description: "Sign out, disconnect this hub, or erase data." },
}

const categoryOrder: SettingsCategory[] = ["general", "family", "display", "network", "calendars", "maintenance", "account"]

function readStoredCategory(): SettingsCategory {
  try {
    const stored = sessionStorage.getItem(CATEGORY_STORAGE_KEY) as SettingsCategory | null
    if (stored && stored in categoryMeta) return stored
  } catch {
    // Storage unavailable
  }
  return "general"
}

function SettingsGroup({ title, tone, children }: { title: string; tone?: "destructive"; children: React.ReactNode }) {
  return (
    <section>
      <h2 className={cn("os-label px-1 pb-4", tone === "destructive" && "!text-destructive")}>{title}</h2>
      <div className="divide-y divide-hairline overflow-hidden rounded-md border border-hairline bg-card">{children}</div>
    </section>
  )
}

function DeviceIdentityCard() {
  const { state: kioskState } = useKiosk()
  return (
    <section>
      <h2 className="os-label px-1 pb-4">This Device</h2>
      <div className="flex items-end gap-3 rounded-md border border-hairline bg-card px-5 py-6">
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-5xl leading-none">{kioskState.deviceName}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            {kioskState.paired ? kioskState.householdName ?? "Connected household" : "Not connected to a household"}
          </p>
        </div>
        <span className="os-label flex shrink-0 items-center gap-2">
          <span className={cn("size-1.5 rounded-full", kioskState.paired ? "bg-season" : "bg-muted-foreground/50")} />
          {kioskState.paired ? "Paired" : "Unpaired"}
        </span>
      </div>
    </section>
  )
}

function AccountResetSection() {
  const { clearNotifications, can } = useStore()
  const authCtx = useOptionalAuth()
  const signOut = authCtx?.signOut ?? (async () => { })
  const { state: kioskState, unpair } = useKiosk()
  const [confirm, setConfirm] = useState<null | "signout" | "clear" | "reset" | "delete" | "unpair">(null)
  const [factoryResetOpen, setFactoryResetOpen] = useState(false)

  const confirmMeta = {
    signout: {
      title: "Sign out?",
      message: "You will need to sign back in to access your family hub.",
      confirmLabel: "Sign out",
      onConfirm: () => { void signOut() },
    },
    clear: {
      title: "Clear notifications?",
      message: "All notifications will be permanently removed.",
      confirmLabel: "Clear all",
      onConfirm: () => clearNotifications(),
    },
    reset: {
      title: "Clear hub data?",
      message: "All events, chores, lists and meals will be permanently removed. This cannot be undone.",
      confirmLabel: "Clear data",
      onConfirm: () => { },
    },
    delete: {
      title: "Delete account?",
      message: "This permanently deletes your account and all family data. This cannot be undone.",
      confirmLabel: "Delete account",
      onConfirm: () => { void signOut() },
    },
    unpair: {
      title: "Disconnect hub?",
      message: `Removes this display from ${kioskState.householdName ?? "your household"}. It will show a new display code to pair again.`,
      confirmLabel: "Disconnect",
      onConfirm: () => { void unpair() },
    },
  } as const

  const active = confirm ? confirmMeta[confirm] : null
  const showSignOut = !kioskConfig.enabled && !kioskConfig.hideSignOut

  return (
    <>
      <SettingsGroup title="Account">
        {showSignOut ? <ActionRow icon={LogOut} label="Sign out" onClick={() => setConfirm("signout")} /> : null}
        <ActionRow
          icon={Bell}
          label="Clear notifications"
          description="Remove all notification history on this hub"
          onClick={() => setConfirm("clear")}
        />
        {kioskState.paired ? (
          <ActionRow
            icon={Link2Off}
            label="Disconnect hub"
            description={`Unpair from ${kioskState.householdName ?? "household"} and show a new display code`}
            onClick={() => setConfirm("unpair")}
          />
        ) : null}
      </SettingsGroup>

      {can("hub") ? (
        <SettingsGroup title="Danger Zone" tone="destructive">
          <ActionRow
            icon={RefreshCw}
            label="Reset hub data"
            description="Permanently removes all events, chores, lists and meals"
            onClick={() => setConfirm("reset")}
            destructive
          />
          <ActionRow
            icon={Trash2}
            label="Delete account"
            description="Permanently deletes your account and all family data"
            onClick={() => setConfirm("delete")}
            destructive
          />
          <ActionRow
            icon={RotateCcw}
            label="Factory reset"
            description="Erase everything and return to the setup wizard"
            onClick={() => setFactoryResetOpen(true)}
            destructive
          />
        </SettingsGroup>
      ) : null}

      <FactoryResetDialog open={factoryResetOpen} onClose={() => setFactoryResetOpen(false)} />

      <ConfirmDialog
        open={!!active}
        title={active?.title ?? ""}
        message={active?.message ?? ""}
        confirmLabel={active?.confirmLabel}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          active?.onConfirm()
          setConfirm(null)
        }}
      />
    </>
  )
}

function CategoryContent({ category }: { category: SettingsCategory }) {
  const { deviceState } = useKiosk()
  switch (category) {
    case "general":
      return (
        <>
          <DeviceIdentityCard />
          <LanguageRegionSection initialOrientation={deviceState.orientation} />
        </>
      )
    case "family":
      return <FamilyMembersSection />
    case "display":
      return (
        <>
          <HomeScreenSection />
          <InterfaceSection />
          <AppearanceSection />
          <SoundDisplaySection />
          <SlideshowSection initialIdleMins={deviceState.slideshowIdleMins ?? 5} />
        </>
      )
    case "network":
      return (
        <>
          <WifiSection />
          <CentralConnectionSection />
        </>
      )
    case "calendars":
      return <CalendarIntegrationSection />
    case "maintenance":
      return <HubActionsSection />
    case "account":
      return <AccountResetSection />
  }
}

export function SettingsView() {
  const { members } = useStore()
  const { state: kioskState } = useKiosk()
  const pendingUpdate = useSyncExternalStore(subscribeUpdate, getPendingUpdate, getPendingUpdate)
  const [category, setCategory] = useState<SettingsCategory>(readStoredCategory)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    import("@tauri-apps/api/app")
      .then(({ getVersion }) => getVersion())
      .then(setAppVersion)
      .catch(() => null)
  }, [])

  const select = (next: SettingsCategory) => {
    setCategory(next)
    try {
      sessionStorage.setItem(CATEGORY_STORAGE_KEY, next)
    } catch {
      // Storage unavailable
    }
    // Start each category at the top of the scrolling panel.
    contentRef.current?.closest("main")?.scrollTo({ top: 0 })
  }

  const peopleCount = members.filter((m) => m.id !== "family").length
  const hints: Partial<Record<SettingsCategory, React.ReactNode>> = {
    general: kioskState.paired ? "Paired" : "Unpaired",
    family: peopleCount > 0 ? `${peopleCount}` : null,
    maintenance: pendingUpdate ? (
      <span className="rounded-full bg-member-green/15 px-2 py-0.5 text-[0.7rem] font-semibold text-member-green">Update</span>
    ) : null,
  }

  const meta = categoryMeta[category]

  return (
    <div ref={contentRef} className="flex flex-col gap-8 py-2 md:flex-row md:items-start md:gap-10">
      {/* Category rail — horizontal chips on narrow screens, sticky sidebar on wide ones */}
      <nav
        aria-label="Settings categories"
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:sticky md:top-0 md:mx-0 md:w-64 md:shrink-0 md:flex-col md:gap-1 md:overflow-visible md:px-0 md:pb-0"
      >
        {categoryOrder.map((id) => {
          const item = categoryMeta[id]
          const Icon = item.icon
          const selected = id === category
          const hint = hints[id]
          return (
            <button
              key={id}
              type="button"
              onClick={() => select(id)}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-3 rounded-md px-3.5 py-3 text-left text-sm transition-colors",
                selected
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:bg-secondary/70 hover:text-foreground active:bg-secondary",
                id === "account" && "md:mt-4",
              )}
            >
              <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
              <span className="flex-1 font-medium whitespace-nowrap">{item.label}</span>
              {hint ? (
                <span className={cn("hidden text-xs md:inline", selected ? "text-background/70" : "text-muted-foreground")}>
                  {hint}
                </span>
              ) : null}
            </button>
          )
        })}
        <p className="os-label hidden px-3.5 pt-6 md:block">Solora OS{appVersion ? ` · v${appVersion}` : ""}</p>
      </nav>

      {/* Active category */}
      <div className="min-w-0 flex-1 space-y-12 pb-10">
        <header className="border-b border-hairline pb-6">
          <h1 className="font-display text-5xl leading-none">{meta.label}</h1>
          <p className="mt-3 text-sm text-muted-foreground">{meta.description}</p>
        </header>
        <CategoryContent category={category} />
        <p className="os-label md:hidden">Solora OS{appVersion ? ` · v${appVersion}` : ""}</p>
      </div>
    </div>
  )
}
