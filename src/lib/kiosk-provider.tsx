"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  ensureRegistered,
  fetchHubInfo,
  fetchKioskState,
  getDeviceToken,
  saveSetup,
  sendHeartbeat,
  unpairKiosk,
  type KioskState,
} from "./kiosk-session"
import { tokenStore } from "./local-api"
import { collectKioskMetrics } from "./kiosk-metrics"
import { notify } from "./push"
import {
  loadDeviceState,
  patchDeviceState,
  DEFAULT_DEVICE_STATE,
  type DeviceState,
} from "./device-state"
import type { SetupValues } from "@/app/kiosk/setup/setup-wizard"

/**
 * Kiosk startup phases:
 *
 *   splash      – loading local device state on boot (brief)
 *   setup       – setup wizard: language, wifi, timezone, name (first run)
 *   registering – enrolling device with the local server to get a pairing code
 *   activate    – no household exists on this hub yet; sign up/in with
 *                 Supabase + an activation code right on this device
 *   pairing     – QR / code shown; waiting for a household member (on an
 *                 already-claimed hub) to claim this additional display
 *   ready       – claimed and set up; show the home dashboard
 *
 * Key design principle: the local Express server is optional during the setup
 * wizard. We only need it once the user taps "Finish setup". That way the
 * kiosk UI still loads even if the server hasn't fully started yet.
 */
export type KioskPhase = "splash" | "setup" | "registering" | "activate" | "pairing" | "ready"

/**
 * Decide which screen to show for an unpaired device: "activate" if no
 * household exists anywhere on this hub yet (first device/user ever), or
 * "pairing" (QR flow) if a household already exists (this is an additional
 * display). Fails safe toward "pairing" — the known-working flow — if the
 * hub/info probe can't be reached.
 */
async function decideUnpairedPhase(): Promise<"activate" | "pairing"> {
  const info = await fetchHubInfo()
  return info && info.claimed === false ? "activate" : "pairing"
}

type KioskContextValue = {
  state: KioskState
  deviceState: DeviceState
  phase: KioskPhase
  loading: boolean
  registrationError: string | null
  initError: string | null
  savingSetup: boolean
  setupError: string | null
  retryRegistration: () => Promise<void>
  completeSetup: (values: SetupValues) => Promise<void>
  refresh: () => Promise<void>
  unpair: () => Promise<void>
}

const KioskContext = createContext<KioskContextValue | null>(null)

const PAIR_POLL_MS    = 3_000
const HEARTBEAT_MS    = 30_000
const REGISTER_TIMEOUT_MS = 8_000

const INITIAL_STATE: KioskState = {
  found: false,
  deviceId: null,
  deviceName: "Kiosk Display",
  paired: false,
  pairingCode: null,
  householdId: null,
  householdName: null,
  setupComplete: false,
  language: null,
  timezone: null,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap a promise with a timeout so it never hangs indefinitely. */
function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(msg)), ms),
    ),
  ])
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function KioskProvider({ children }: { children: ReactNode }) {
  const [state, setState]                   = useState<KioskState>(INITIAL_STATE)
  const [deviceState, setDeviceState]       = useState<DeviceState>(DEFAULT_DEVICE_STATE)
  const [phase, setPhase]                   = useState<KioskPhase>("splash")
  const [loading, setLoading]               = useState(true)
  const [initError, setInitError]           = useState<string | null>(null)
  const [registrationError, setRegistrationError] = useState<string | null>(null)
  const [savingSetup, setSavingSetup]       = useState(false)
  const [setupError, setSetupError]         = useState<string | null>(null)

  const pairedRef    = useRef(false)
  const readyRef     = useRef(false)   // true once registration+pairing loop can start

  // ------------------------------------------------------------------
  // refresh — poll kiosk state from the local server
  // ------------------------------------------------------------------
  const refresh = useCallback(async () => {
    try {
      const prev = pairedRef.current
      const next = await fetchKioskState()
      pairedRef.current = next.paired
      setState(next)

      if (!prev && next.paired && next.householdName) {
        void notify("Kiosk claimed", `This hub is now connected to ${next.householdName}.`)
      }
      if (prev && !next.paired) {
        void notify("Kiosk disconnected", "This hub has been unpaired from its household.")
      }
    } catch (err) {
      console.error("[kiosk] fetchKioskState error:", err)
    }
  }, [])

  const unpair = useCallback(async () => {
    await unpairKiosk()
    await refresh()
  }, [refresh])

  // ------------------------------------------------------------------
  // doRegister — enroll with the local server (idempotent)
  // ------------------------------------------------------------------
  const doRegister = useCallback(async (deviceName?: string): Promise<boolean> => {
    setRegistrationError(null)
    setPhase("registering")
    try {
      await withTimeout(
        ensureRegistered(deviceName),
        REGISTER_TIMEOUT_MS,
        "Local server did not respond in time. Make sure lumora-server is running.",
      )
      // Bridge the device JWT into the shared tokenStore so that store.tsx
      // API calls (listChores, listEvents, etc.) send a valid Bearer token.
      const deviceJwt = getDeviceToken()
      if (deviceJwt) tokenStore.set(deviceJwt)
      return true
    } catch (err) {
      console.error("[kiosk] registration error:", err)
      setRegistrationError(
        err instanceof Error ? err.message : "Could not reach the local server.",
      )
      return false
    }
  }, [])

  const retryRegistration = useCallback(async () => {
    const ok = await doRegister(deviceState.deviceName ?? undefined)
    if (ok) {
      await refresh()
      const server = await fetchKioskState()
      pairedRef.current = server.paired
      setState(server)
      if (server.paired) setPhase("ready")
      else setPhase(await decideUnpairedPhase())
    }
  }, [doRegister, refresh, deviceState.deviceName])

  // ------------------------------------------------------------------
  // completeSetup — persist locally, sync to server best-effort, advance
  // ------------------------------------------------------------------
  const completeSetup = useCallback(
    async (values: SetupValues) => {
      setSavingSetup(true)
      setSetupError(null)

      // 1. Persist to local device-state store (Tauri store / localStorage).
      //    This is the source of truth. If it fails we stop here.
      let nextLocal: DeviceState
      try {
        nextLocal = await patchDeviceState({
          setupComplete: true,
          language:      values.language,
          timezone:      values.timezone,
          deviceName:    values.deviceName,
          orientation:   values.orientation,
        })
        setDeviceState(nextLocal)
      } catch (err) {
        console.error("[kiosk] completeSetup local persist error:", err)
        setSetupError(
          err instanceof Error ? err.message : "Could not save setup. Please try again.",
        )
        setSavingSetup(false)
        return
      }

      // 2. Register with the local server (gets us a pairing code).
      //    If the server isn't running this will show the registering/retry screen.
      const ok = await doRegister(values.deviceName)
      if (!ok) {
        // registrationError is already set inside doRegister; UI shows retry.
        setSavingSetup(false)
        return
      }

      // 3. Sync setup values to the local server (best-effort).
      try {
        await withTimeout(
          saveSetup(values),
          REGISTER_TIMEOUT_MS,
          "Setup sync timed out.",
        )
      } catch (err) {
        console.error("[kiosk] setup sync error (non-fatal):", err)
        setSetupError("Setup saved locally. Server sync failed — will retry on next boot.")
      }

      // 4. Fetch fresh state to get the pairing code.
      await refresh()

      // 5. Advance — paired already (e.g. dev reset) goes straight to ready.
      readyRef.current = true
      setSavingSetup(false)
      setPhase(pairedRef.current ? "ready" : await decideUnpairedPhase())
    },
    [doRegister, refresh],
  )

  // ------------------------------------------------------------------
  // Boot sequence: splash → maybe setup, maybe pairing, maybe ready
  // ------------------------------------------------------------------
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        // Load persisted device state (fast — local file/localStorage).
        const local = await loadDeviceState()
        if (!alive) return
        setDeviceState(local)

        if (!local.setupComplete) {
          // First run — show the setup wizard. Don't touch the server yet.
          setPhase("setup")
          setLoading(false)
          return
        }

        // Setup was done on a previous boot. Re-register with the server
        // (idempotent — returns the existing token if we already have one).
        const ok = await doRegister(local.deviceName ?? undefined)
        if (!alive) return
        if (!ok) {
          // Server unreachable — registrationError is set; show retry screen.
          setLoading(false)
          return
        }

        // Fetch pairing/claim state.
        let server = await fetchKioskState()
        if (!alive) return

        // Hub DB was wiped — token was cleared inside fetchKioskState.
        // Re-register fresh so we get a new pairing code.
        if (!server.found) {
          const ok2 = await doRegister(local.deviceName ?? undefined)
          if (!alive) return
          if (!ok2) { setLoading(false); return }
          server = await fetchKioskState()
          if (!alive) return
        }

        pairedRef.current = server.paired
        setState(server)
        readyRef.current = true

        if (server.paired) setPhase("ready")
        else setPhase(await decideUnpairedPhase())
      } catch (err) {
        console.error("[kiosk] init error:", err)
        if (alive) setInitError(err instanceof Error ? err.message : "Failed to start.")
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [doRegister])

  // Keep phase in sync when pairing state changes live (claimed while waiting).
  useEffect(() => {
    if (!readyRef.current) return
    if (state.paired) setPhase("ready")
    else if (phase === "ready") setPhase("pairing")
  }, [state.paired, phase])

  // Poll / heartbeat loop.
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined

    const loop = async () => {
      if (!alive || !readyRef.current) {
        timer = setTimeout(loop, 500)
        return
      }
      try {
        if (!pairedRef.current) {
          await refresh()
        } else {
          const m = await collectKioskMetrics()
          await sendHeartbeat(m)
        }
      } catch { /* transient */ }
      if (!alive) return
      timer = setTimeout(loop, pairedRef.current ? HEARTBEAT_MS : PAIR_POLL_MS)
    }

    timer = setTimeout(loop, PAIR_POLL_MS)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [refresh])

  const value = useMemo<KioskContextValue>(
    () => ({
      state, deviceState, phase, loading,
      registrationError, initError,
      savingSetup, setupError,
      retryRegistration, completeSetup, refresh, unpair,
    }),
    [
      state, deviceState, phase, loading,
      registrationError, initError,
      savingSetup, setupError,
      retryRegistration, completeSetup, refresh, unpair,
    ],
  )

  return <KioskContext.Provider value={value}>{children}</KioskContext.Provider>
}

export function useKiosk() {
  const ctx = useContext(KioskContext)
  if (!ctx) throw new Error("useKiosk must be used within KioskProvider")
  return ctx
}
