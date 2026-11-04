"use client"

import { useEffect, useState } from "react"
import { WaveLoader } from "@/components/os/loading"
import { api } from "@/lib/api"
import {
  claimThisDevice, fetchHubSetup, fetchKioskState, moveFromOldHub, setupQrPayload, type HubSetup, type MoveSummary,
} from "@/lib/kiosk-session"
import { QrCode } from "@/components/ui/reusables/qr-code"
import { useKiosk } from "@/lib/kiosk-provider"
import { SystemHeading, SystemScreen } from "@/components/os/system-screen"
import { cn } from "@/lib/utils"

const inputClass = "os-field"

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="os-label">{label}</span>
      {children}
    </label>
  )
}

/**
 * Shown when no household exists on this hub yet (GET /hub/info → claimed:
 * false) — the very first device/user for a brand-new hub. Replaces the QR
 * pairing flow for this case: sign up or sign in with Supabase directly on
 * the display, gated by the hub's setup code (filled in automatically when
 * this display runs on the hub itself), then this device links itself into the new
 * household automatically. Additional displays on an already-claimed hub
 * still use the existing QR pairing-screen.tsx flow, untouched.
 */
export function ActivateScreen() {
  const { refresh } = useKiosk()

  const [mode, setMode] = useState<"signup" | "signin">("signup")
  const [name, setName] = useState("")
  const [householdName, setHouseholdName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [activationCode, setActivationCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<"form" | "linking">("form")

  // Moving from an old hub instead of starting fresh.
  const [moving, setMoving] = useState(false)
  const [moveCode, setMoveCode] = useState("")
  const [moveFrom, setMoveFrom] = useState("")
  const [showMoveFrom, setShowMoveFrom] = useState(false)
  const [moved, setMoved] = useState<MoveSummary | null>(null)

  async function runMove(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      setMoved(await moveFromOldHub(moveCode.trim(), moveFrom.trim()))
    } catch (err) {
      setError(err instanceof Error ? err.message : "The move didn't finish. Try again.")
      // Searching the network found nothing: let them type the old hub's address.
      if (!showMoveFrom && err instanceof Error && /find your old hub/i.test(err.message)) setShowMoveFrom(true)
    } finally {
      setBusy(false)
    }
  }
  // Read from the hub itself: fills in the code here and becomes the QR a phone can scan.
  const [setup, setSetup] = useState<HubSetup | null>(null)

  useEffect(() => {
    let cancelled = false
    void fetchHubSetup().then((s) => {
      if (cancelled || !s) return
      setSetup(s)
      setActivationCode(s.setupCode)
    })
    return () => { cancelled = true }
  }, [])

  // Set once sign-up/sign-in succeeds so a retry after a failed link step
  // doesn't re-submit credentials (which would fail as "already registered").
  const [sessionToken, setSessionToken] = useState<string | null>(null)

  async function linkDevice(token: string) {
    const kioskState = await fetchKioskState()
    if (!kioskState.pairingCode) {
      throw new Error("This device isn't registered yet — wait a moment and try again.")
    }
    await claimThisDevice(token, kioskState.pairingCode)
    await refresh()
  }

  async function runFlow() {
    setError(null)
    setBusy(true)
    try {
      let token = sessionToken
      if (!token) {
        const res =
          mode === "signup"
            ? await api.signUp({ name, email, password, householdName, setupCode: activationCode })
            : await api.signIn({ email, password })
        token = res.token
        setSessionToken(token)
      }
      setStep("linking")
      await linkDevice(token)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong."
      if (mode === "signup" && /already registered|already exists/i.test(message)) {
        setMode("signin")
        setSessionToken(null)
        setStep("form")
        setError("You already have an account on file — sign in instead.")
      } else {
        setError(message)
      }
    } finally {
      setBusy(false)
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    void runFlow()
  }

  return (
    <SystemScreen
      footerRight={
        <span className="flex items-center gap-2">
          <span className="size-1.5 animate-pulse rounded-full bg-season" />
          Broadcasting on your network
        </span>
      }
      className="grid items-end gap-12 overflow-y-auto px-10 pb-14 pt-10 lg:landscape:grid-cols-[1.1fr_1fr] lg:landscape:gap-20"
    >
      <SystemHeading
        eyebrow={moving ? "From your old hub" : mode === "signup" ? "First hub on this network" : "Existing family"}
        title={moved ? `Welcome home, ${moved.householdName}.` : moving ? "Moving in." : mode === "signup" ? "Start your family." : "Welcome back."}
      >
        {moved ? (
          <p>Your family is on this hub now.</p>
        ) : moving ? (
          <p>
            Everything comes across: your family, chores, lists, meals, events, photos and linked calendars. Keep the
            old hub plugged in until this finishes.
          </p>
        ) : mode === "signup" ? (
          <p>Create the account that will run this hub, here or on your phone.</p>
        ) : (
          <p>Sign in with the account that already manages a Solora hub.</p>
        )}
        {mode === "signup" && setup && !moving ? (
          <div className="mt-8 flex items-center gap-6">
            <QrCode value={setupQrPayload(setup)} size={148} className="shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-foreground">Setting up from your phone?</p>
              <p className="mt-1 text-pretty text-sm text-muted-foreground">
                Open Solora, create your account, then scan this code.
              </p>
              <p className="os-label mt-4">Setup code</p>
              <p className="mt-1 font-mono text-2xl tracking-[0.3em]">{setup.setupCode}</p>
            </div>
          </div>
        ) : null}
      </SystemHeading>

      <div className="w-full max-w-md lg:landscape:justify-self-end portrait:max-w-xl">
        {moved ? (
          <div className="flex flex-col gap-6 border-t border-border pt-8">
            <ul className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {([
                [moved.members, "person", "people"],
                [moved.photos, "photo", "photos"],
                [moved.events, "event", "events"],
                [moved.chores, "chore", "chores"],
                [moved.lists, "list", "lists"],
                [moved.meals, "meal", "meals"],
              ] as const).map(([n, one, many]) => (
                <li key={many}><span className="tabular font-semibold">{n}</span> {n === 1 ? one : many}</li>
              ))}
            </ul>
            <p className="text-pretty text-sm text-muted-foreground">
              On each phone, open Settings › Connect to a different hub. Kids without an email get a new invite from a
              parent.{moved.calendarsLinked > 0 ? " Linked calendars keep syncing." : ""} You can unplug the old hub now.
            </p>
            <button type="button" onClick={() => void refresh()} className="os-button self-start">
              Continue
            </button>
          </div>
        ) : moving ? (
          <form onSubmit={(e) => void runMove(e)} className="flex flex-col gap-6">
            <p className="text-pretty text-sm text-muted-foreground">
              On your phone, open Settings › Move to a new hub, then type the code it shows.
            </p>
            <Labeled label="Transfer code">
              <input
                className={cn(inputClass, "font-mono uppercase tracking-[0.3em]")}
                placeholder="XXXX-XXXX"
                value={moveCode}
                onChange={(e) => setMoveCode(e.target.value)}
                autoComplete="off"
                required
              />
            </Labeled>
            {showMoveFrom ? (
              <Labeled label="Old hub's address (optional)">
                <input
                  className={inputClass}
                  placeholder="192.168.1.20"
                  value={moveFrom}
                  onChange={(e) => setMoveFrom(e.target.value)}
                  autoComplete="off"
                />
              </Labeled>
            ) : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
              <button type="submit" disabled={busy} className="os-button">
                {busy ? <WaveLoader size={16} /> : null}
                {busy ? "Moving your family…" : "Move to this hub"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setMoving(false); setError(null) }}
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Start a new family instead
              </button>
            </div>
          </form>
        ) : step === "linking" ? (
          <div className="flex flex-col gap-6 border-t border-border pt-8">
            <p className="font-display text-4xl leading-tight">Linking this display to your family…</p>
            {!error ? <div className="boot-line h-[2px] bg-hairline" /> : null}
            {error ? (
              <div className="flex flex-col items-start gap-4">
                <p className="text-sm text-destructive">{error}</p>
                <button type="button" disabled={busy} onClick={() => void runFlow()} className="os-button">
                  {busy ? <WaveLoader size={16} /> : null}
                  Try again
                </button>
              </div>
            ) : null}
          </div>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-6">
            {mode === "signup" ? (
              <div className="grid grid-cols-2 gap-6">
                <Labeled label="Your name">
                  <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required />
                </Labeled>
                <Labeled label="Family name">
                  <input
                    className={inputClass}
                    placeholder="The Peaks"
                    value={householdName}
                    onChange={(e) => setHouseholdName(e.target.value)}
                  />
                </Labeled>
              </div>
            ) : null}

            <Labeled label="Email">
              <input
                className={inputClass}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
            </Labeled>
            <Labeled label={mode === "signup" ? "Create a password" : "Password"}>
              <input
                className={inputClass}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={6}
                required
              />
            </Labeled>

            {/* Only asked for when this display isn't on the hub itself and couldn't read it. */}
            {mode === "signup" && !setup ? (
              <Labeled label="Setup code (on your hub's screen)">
                <input
                  className={cn(inputClass, "font-mono uppercase tracking-[0.3em]")}
                  value={activationCode}
                  onChange={(e) => setActivationCode(e.target.value)}
                  required
                />
              </Labeled>
            ) : null}

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <div className="mt-2 flex flex-wrap items-center justify-between gap-4">
              <button type="submit" disabled={busy} className="os-button">
                {busy ? <WaveLoader size={16} /> : null}
                {mode === "signup" ? "Activate hub" : "Sign in"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setMode(mode === "signup" ? "signin" : "signup")
                }}
                className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                {mode === "signup" ? "I already have an account" : "Create a new family"}
              </button>
            </div>
            {mode === "signup" ? (
              <button
                type="button"
                onClick={() => { setMoving(true); setError(null) }}
                className="self-start border-t border-border pt-5 text-sm text-foreground underline-offset-4 hover:underline"
              >
                Moving from another Solora hub? Bring your family over
              </button>
            ) : null}
          </form>
        )}
      </div>
    </SystemScreen>
  )
}
