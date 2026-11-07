"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { kioskToast } from "@/components/os/kiosk-toast"
import { SideNav } from "@/components/ui/reusables/side-nav"
import { HeaderNav } from "@/components/ui/reusables/header-nav"
import { CalendarView } from "@/app/calendar/calender"
import { ChoresView } from "@/app/chores/chores"
import { ListsView } from "@/app/lists/lists"
import { MealsView } from "@/app/meals/meals"
import { PhotosView, SLIDESHOW_EVENT } from "@/app/photos/photos"
import { SettingsView } from "@/app/settings/settings"
import { HomeView } from "@/app/home/home"
import { getDisplayPrefs } from "@/lib/display-prefs"
import { SlideshowScreen } from "./slideshow-screen"
import { QuietHours } from "@/components/os/quiet-hours"
import { WallPresence } from "@/components/os/wall-presence"
import { onWallWake } from "@/lib/wall-wake"
import { useStore, type TabKey } from "@/lib/store"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"
import { centralSocket } from "@/lib/central-socket"
import { logConnectionHealth } from "@/lib/connection-health"
import { restartHub, reloadDisplay, clearCache, addLog, checkForUpdates, installUpdate } from "@/lib/hub"
import { startFleetControl } from "@/lib/fleet-control"
import { setOrientation } from "@/lib/locale-service"
import { patchDeviceState } from "@/lib/device-state"
import { useKiosk } from "@/lib/kiosk-provider"
import { SystemHeading, SystemScreen } from "@/components/os/system-screen"
import { ErrorBoundary } from "@/components/os/error-state"
import { TabLoading } from "@/components/os/loading"
import { useTabCaption } from "@/lib/tab-caption"

/**
 * Each tab's header. The caption above the title is a live count (lib/tab-caption),
 * the same line the phone shows. Home and Calendar draw their own titles (the
 * clock; the month with its arrows). Pages that filter by person get the faces.
 */
const headers: Record<TabKey, { title: string; customTitle?: boolean; showPeople?: boolean }> = {
  home: { title: "Home", customTitle: true },
  calendar: { title: "Calendar", customTitle: true, showPeople: true },
  chores: { title: "Chores", showPeople: true },
  rewards: { title: "Chores" },
  lists: { title: "Lists" },
  meals: { title: "Meals" },
  photos: { title: "Photos" },
  settings: { title: "Settings" },
}

/** Re-renders the caller once a minute. */
function useMinute() {
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
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
  // Re-read each minute so the date in Home's caption turns over at midnight;
  // the wall runs for weeks, so it can't be worked out once at startup.
  useMinute()
  const caption = useTabCaption(tab)

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

  const returnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resetIdleTimer = useCallback(() => {
    if (returnTimerRef.current) clearTimeout(returnTimerRef.current)
    const { startTab, returnAfterMins } = getDisplayPrefs()
    if (returnAfterMins) returnTimerRef.current = setTimeout(() => setTab(startTab), returnAfterMins * 60 * 1000)
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    if (!idleMins || photos.length === 0) return
    idleTimerRef.current = setTimeout(
      () => setSlideshowActive(true),
      idleMins * 60 * 1000,
    )
  }, [idleMins, photos.length, setTab])

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

  // Provisioning prompts and log collection from the Solora console.
  useEffect(() => startFleetControl(), [])

  // ── Central socket events (OTA, lock, notifications from portal) ──────────
  useEffect(() => {
    // Security invariant: a push only triggers the Tauri updater check, which
    // downloads from the configured endpoint and verifies the minisign
    // signature. Never install from payload.url — a compromised central could
    // point it anywhere.
    const unsubOta = centralSocket.onOtaPush((payload) => {
      addLog("info", "system", `OTA push received: v${payload.version} — checking updater${payload.force ? " (install now)" : ""}`)
      void checkForUpdates(payload.job_id)
        // "Force update" from the console skips the quiet-hours wait; the
        // updater still verifies the signature as always.
        .then((found) => { if (found && payload.force) return installUpdate() })
        .catch(() => {
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
      kioskToast.notice(payload.title, { description: payload.body })
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

  // Photos' Slideshow button starts it now.
  useEffect(() => {
    const start = () => photos.length > 0 && setSlideshowActive(true)
    window.addEventListener(SLIDESHOW_EVENT, start)
    return () => window.removeEventListener(SLIDESHOW_EVENT, start)
  }, [photos.length])

  // Someone walked up with their phone: off the slideshow, like a touch.
  useEffect(() => onWallWake(dismissSlideshow), [dismissSlideshow])

  return (
    <>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        {/* System status bar — WiFi, date, clock — always visible at top */}
        <SystemStatusBar label={deviceState.deviceName ?? undefined} hideClock={tab === "home"} />

        {/* flex-1 + overflow-hidden so this row fills remaining height exactly */}
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar — fixed height, no scroll */}
          <SideNav active={tab} onChange={setTab} />

          {/* Right panel: header + scrollable content */}
          <div className="relative flex flex-1 flex-col overflow-hidden">
            <HeaderNav title={head.title} caption={caption} customTitle={head.customTitle} showPeople={head.showPeople} />

            {/* Only this element scrolls — overflow-y-auto, never x */}
            <main data-effects-area className={`overflow-x-hidden ${tab === "calendar" ? "flex flex-1 flex-col overflow-hidden" : "flex-1 overflow-y-auto"}`}>
              {tab === "home" && !loading ? (
                <ErrorBoundary resetKey={tab}>
                  <HomeView />
                </ErrorBoundary>
              ) : null}
              {loading && tab !== "settings" ? (
                <TabLoading tab={tab} wall className="px-8 py-6" />
              ) : tab === "home" ? null : tab === "calendar" ? (
                <ErrorBoundary resetKey={tab}>
                  <CalendarView />
                </ErrorBoundary>
              ) : (
                // Full width and at least full height: pages lay out across the wall
                // (lanes, a week strip, two panes) instead of one stretched phone column.
                <div className="page-in flex min-h-full flex-col px-8 py-6" key={tab === "rewards" ? "chores" : tab}>
                  <ErrorBoundary resetKey={tab}>
                    {(tab === "chores" || tab === "rewards") && <ChoresView />}
                    {tab === "lists" && <ListsView />}
                    {tab === "meals" && <MealsView />}
                    {tab === "photos" && <PhotosView />}
                    {tab === "settings" && <SettingsView />}
                  </ErrorBoundary>
                </div>
              )}
            </main>
          </div>
        </div>
      </div>

      {slideshowActive && photos.length > 0 && (
        <SlideshowScreen photos={photos} onDismiss={dismissSlideshow} />
      )}

      <QuietHours />
      <WallPresence />

      {maintenanceLock.locked && (
        <div className="fixed inset-0 z-[9999]">
          <SystemScreen footerRight="Resumes automatically" className="justify-end px-10 pb-16">
            <SystemHeading eyebrow="Maintenance" title="Back in a moment.">
              <p>{maintenanceLock.reason ?? "This display is being looked after remotely."}</p>
            </SystemHeading>
          </SystemScreen>
        </div>
      )}
    </>
  )
}
