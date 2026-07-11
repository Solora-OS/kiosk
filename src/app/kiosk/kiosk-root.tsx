"use client"

import { WifiOff } from "lucide-react"
import { KioskProvider, useKiosk } from "@/lib/kiosk-provider"
import { StoreProvider } from "@/lib/store"
import { PairingScreen } from "./pairing-screen"
import { ActivateScreen } from "./activate-screen"
import { KioskAppShell } from "./kiosk-app-shell"
import { SplashScreen } from "./splash-screen"
import { RegisteringScreen } from "./registering-screen"
import { SetupWizard } from "./setup/setup-wizard"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"

/**
 * Root for the kiosk experience (a wall-mounted family display).
 *
 * Drives the full appliance startup flow as a state machine so the user never
 * sees Linux/Ubuntu, desktop, or app restarts — just smooth Lumora screens:
 *
 *   splash → registering (MDM enroll) → setup wizard → activate (first hub)
 *     or pairing (additional display) → home dashboard
 */
function KioskGate() {
  const {
    phase,
    loading,
    initError,
    registrationError,
    savingSetup,
    setupError,
    deviceState,
    retryRegistration,
    completeSetup,
    refresh,
  } = useKiosk()

  // Hard failure talking to the backend (e.g. RPC not deployed).
  if (initError) {
    return (
      <div className="flex min-h-dvh flex-col bg-background">
        <SystemStatusBar />
        <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
          <WifiOff className="size-10 text-muted-foreground" />
          <div>
            <p className="text-lg font-semibold text-foreground">Could not connect</p>
            <p className="mt-1 max-w-xs text-pretty text-sm text-muted-foreground">
              {initError}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  // Booting: loading local device state.
  if (loading && phase === "splash") {
    return <SplashScreen message="Starting up" />
  }

  // Step 2 — registering with Lumora Cloud (with retry on failure).
  if (phase === "registering") {
    return (
      <RegisteringScreen error={registrationError} onRetry={() => void retryRegistration()} />
    )
  }

  // Step 3 — setup wizard (language, WiFi, timezone, name).
  if (phase === "setup") {
    return (
      <SetupWizard
        defaults={{
          language: deviceState.language ?? undefined,
          timezone: deviceState.timezone ?? undefined,
          deviceName: deviceState.deviceName ?? undefined,
          orientation: (deviceState.orientation as "normal" | "left" | "right" | "inverted" | undefined) ?? undefined,
        }}
        saving={savingSetup}
        saveError={setupError}
        onComplete={(values) => void completeSetup(values)}
      />
    )
  }

  // Step 4a — no household exists on this hub yet: activate directly on-device.
  if (phase === "activate") {
    return <ActivateScreen />
  }

  // Step 4b — a household already exists; waiting to be claimed as an
  // additional display via the QR pairing flow.
  if (phase === "pairing") {
    return <PairingScreen />
  }

  // Step 5 — registered, set up, and claimed: load the Home dashboard.
  if (phase === "ready") {
    return (
      <StoreProvider kioskMode>
        <KioskAppShell />
      </StoreProvider>
    )
  }

  // Fallback while the phase settles.
  return <SplashScreen message="Starting up" />
}

export function KioskRoot() {
  return (
    <KioskProvider>
      <KioskGate />
    </KioskProvider>
  )
}
