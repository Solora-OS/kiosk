"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Loader2, WrenchIcon } from "lucide-react"
import { toast } from "sonner"
import { SideNav } from "@/components/ui/reusables/side-nav"
import { HeaderNav } from "@/components/ui/reusables/header-nav"
import { MemberChips } from "@/components/ui/reusables/member-chips"
import { CalendarView } from "@/app/calendar/calender"
import { ChoresView } from "@/app/chores/chores"
import { ListsView } from "@/app/lists/lists"
import { MealsView } from "@/app/meals/meals"
import { PhotosView } from "@/app/photos/photos"
import { SettingsView } from "@/app/settings/settings"
import { SlideshowScreen } from "./slideshow-screen"
import { useStore, type TabKey } from "@/lib/store"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"
import { centralSocket } from "@/lib/central-socket"
import { logConnectionHealth } from "@/lib/connection-health"
import { restartHub, reloadDisplay, clearCache, addLog, checkForUpdates } from "@/lib/hub"
import { setOrientation } from "@/lib/locale-service"
import { patchDeviceState } from "@/lib/device-state"
import { useKiosk } from "@/lib/kiosk-provider"

const todaySubtitle = new Date().toLocaleDateString(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
})

const headers: Record<TabKey, { title: string; subtitle?: string; showMembers: boolean }> = {
  calendar: { title: "Calendar", subtitle: todaySubtitle, showMembers: true },
  chores: { title: "Chores", subtitle: "Keep the streak going", showMembers: true },
  lists: { title: "Lists", subtitle: "Shared with the family", showMembers: false },
  meals: { title: "Meals", subtitle: "Dinner plan for the week", showMembers: false },
  photos: { title: "Photos", subtitle: "Family moments on your hub", showMembers: false },
  settings: { title: "Settings", subtitle: "Hub & connection", showMembers: false },
}

/**
 * Paired-kiosk shell. Same family views as the mobile app, but data is
 * read-only (sourced via the kiosk RPC) and the Settings tab is the kiosk's own
 * device/connection panel instead of the account settings.
 */
export function KioskAppShell() {
  const { tab, setTab, loading, photos } = useStore()
  const { deviceState } = useKiosk()
  const head = headers[tab]

  const [slideshowActive, setSlideshowActive] = useState(false)
  const [maintenanceLock, setMaintenanceLock] = useState<{ locked: boolean; reason?: string }>({ locked: false })
  // Keep idle mins in local state so hub commands can update it live without a full reload
  const [idleMins, setIdleMins] = useState<number | null>(deviceState.slideshowIdleMins ?? 5)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync from deviceState when it changes (e.g. after local settings save)
  useEffect(() => {
    setIdleMins(deviceState.slideshowIdleMins ?? 5)
  }, [deviceState.slideshowIdleMins])

  // Log full connection health on mount — visible in Tauri devtools console
  useEffect(() => { void logConnectionHealth() }, [])

  const resetIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    if (!idleMins || photos.length === 0) return
    idleTimerRef.current = setTimeout(
      () => setSlideshowActive(true),
      idleMins * 60 * 1000,
    )
  }, [idleMins, photos.length])

  // Start/restart the idle timer on any user activity
  useEffect(() => {
    resetIdleTimer()
    const events = ["pointermove", "pointerdown", "keydown", "scroll", "touchstart"] as const
    for (const ev of events) window.addEventListener(ev, resetIdleTimer, { passive: true })
    return () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      for (const ev of events) window.removeEventListener(ev, resetIdleTimer)
    }
  }, [resetIdleTimer])

  // ── Central socket events (OTA, lock, notifications from portal) ──────────
  useEffect(() => {
    const unsubOta = centralSocket.onOtaPush((payload) => {
      addLog("info", "system", `OTA push received: v${payload.version} — checking updater`)
      void checkForUpdates(payload.job_id).catch(() => {
        addLog("error", "system", `OTA update check failed for v${payload.version}`)
      })
    })

    const unsubLock = centralSocket.onDeviceLock((payload) => {
      if (payload.locked) {
        addLog("info", "system", `Device locked for maintenance${payload.reason ? `: ${payload.reason}` : ""}`)
        setMaintenanceLock({ locked: true, reason: payload.reason })
      } else {
        addLog("info", "system", "Device unlocked — resuming normal operation")
        setMaintenanceLock({ locked: false })
      }
    })

    const unsubNotif = centralSocket.onNotification((payload) => {
      addLog("info", "system", `Notification: ${payload.title}`)
      toast(payload.title, { description: payload.body, duration: 8000 })
      if (payload.notification_id) centralSocket.notificationAck(payload.notification_id)
    })

    const unsubReboot = centralSocket.onReboot(() => {
      addLog("info", "system", "Remote reboot requested")
      void restartHub()
    })

    return () => {
      unsubOta(); unsubLock(); unsubNotif(); unsubReboot()
    }
  }, [])

  // ── hub:command (remote control via central socket) ───────────────────────
  useEffect(() => {
    const unsub = centralSocket.onHubCommand((cmd) => {
      switch (cmd.type) {
        case "restart":
          void restartHub()
          break
        case "reload":
          reloadDisplay()
          break
        case "clear_cache":
          void clearCache()
          break
        case "set_orientation":
          void setOrientation(cmd.orientation)
            .then((ok) => { if (!ok) addLog("warning", "system", "Remote orientation change failed") })
          break
        case "set_idle_mins":
          setIdleMins(cmd.minutes)
          void patchDeviceState({ slideshowIdleMins: cmd.minutes })
          break
      }
    })
    return () => { unsub() }
  }, [])

  const dismissSlideshow = useCallback(() => {
    setSlideshowActive(false)
    resetIdleTimer()
  }, [resetIdleTimer])

  return (
    <>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        {/* System status bar — WiFi, date, clock — always visible at top */}
        <SystemStatusBar />

        {/* flex-1 + overflow-hidden so this row fills remaining height exactly */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — fixed height, no scroll */}
          <SideNav active={tab} onChange={setTab} />

          {/* Right panel: header + optional chips + scrollable content */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <HeaderNav title={head.title} subtitle={head.subtitle} />
            {head.showMembers ? <MemberChips /> : null}

            {/* Only this element scrolls — overflow-y-auto, never x */}
            <main className={`overflow-x-hidden ${tab === "calendar" ? "flex flex-1 flex-col overflow-hidden" : "flex-1 overflow-y-auto"}`}>
              {loading && tab !== "settings" ? (
                <div className="flex items-center justify-center py-24">
                  <Loader2 className="size-6 animate-spin text-muted-foreground" />
                </div>
              ) : tab === "calendar" ? (
                <CalendarView />
              ) : (
                <div className="mx-auto max-w-6xl px-4 py-4">
                  {tab === "chores" && <ChoresView />}
                  {tab === "lists" && <ListsView />}
                  {tab === "meals" && <MealsView />}
                  {tab === "photos" && <PhotosView />}
                  {tab === "settings" && <SettingsView />}
                </div>
              )}
            </main>
          </div>
        </div>
      </div>

      {slideshowActive && photos.length > 0 && (
        <SlideshowScreen photos={photos} onDismiss={dismissSlideshow} />
      )}

      {maintenanceLock.locked && (
        <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-6 bg-background/95 backdrop-blur-sm">
          <div className="flex size-20 items-center justify-center rounded-full bg-member-amber/15">
            <WrenchIcon className="size-10 text-member-amber" />
          </div>
          <div className="text-center">
            <p className="text-2xl font-bold tracking-tight">Under Maintenance</p>
            <p className="mt-2 text-sm text-muted-foreground">
              {maintenanceLock.reason ?? "This display is temporarily offline for maintenance."}
            </p>
          </div>
          <p className="text-xs text-muted-foreground">It will resume automatically when unlocked.</p>
        </div>
      )}
    </>
  )
}
