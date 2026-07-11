"use client"

import { useState } from "react"
import { Loader2, Sparkles, Wifi } from "lucide-react"
import { api } from "@/lib/api"
import { claimThisDevice, fetchKioskState } from "@/lib/kiosk-session"
import { useKiosk } from "@/lib/kiosk-provider"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"
import { cn } from "@/lib/utils"

const inputClass =
  "w-full rounded-xl border border-border bg-card px-3.5 py-3 text-sm outline-none transition-colors focus:border-primary"

/**
 * Shown when no household exists on this hub yet (GET /hub/info → claimed:
 * false) — the very first device/user for a brand-new hub. Replaces the QR
 * pairing flow for this case: sign up or sign in with Supabase directly on
 * the display, gated by the activation code shown on the hub console
 * (~/.lumora/setup_code), then this device links itself into the new
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
    <main className="flex min-h-dvh flex-col bg-background text-foreground">
      <SystemStatusBar />

      <div className="flex flex-1 flex-col items-center justify-center gap-10 px-10 pb-16 lg:flex-row lg:gap-20">
        {/* Left: broadcasting animation */}
        <div className="flex flex-col items-center gap-6">
          <div className="relative flex size-40 items-center justify-center">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="absolute inset-0 rounded-full border-2 border-primary/40 animate-ping"
                style={{ animationDelay: `${i * 700}ms`, animationDuration: "2.1s" }}
              />
            ))}
            <div className="relative flex size-20 items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-sm">
              <Sparkles className="size-10" />
            </div>
          </div>
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Wifi className="size-4" />
            Broadcasting on your network
          </div>
        </div>

        {/* Right: activation form */}
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center lg:text-left">
            <p className="text-base font-medium uppercase tracking-widest text-primary">
              Set up this hub
            </p>
            <h1 className="mt-2 text-balance text-4xl font-bold leading-tight tracking-tight">
              {mode === "signup" ? "Create your family" : "Sign in"}
            </h1>
            <p className="mt-3 text-pretty text-sm leading-relaxed text-muted-foreground">
              {mode === "signup"
                ? "Enter the activation code shown on this hub's console to finish setup."
                : "Sign in with the account that already manages a Lumora hub."}
            </p>
          </div>

          {step === "linking" ? (
            <div className="flex flex-col items-center gap-4 rounded-2xl border border-border bg-card py-10 text-center">
              <Loader2 className="size-8 animate-spin text-primary" />
              <p className="text-sm font-medium">Linking this display to your family…</p>
              {error ? (
                <div className="mt-2 flex flex-col items-center gap-3 px-6">
                  <p className="text-sm font-medium text-destructive">{error}</p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runFlow()}
                    className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    Try again
                  </button>
                </div>
              ) : null}
            </div>
          ) : (
            <form onSubmit={(e) => void submit(e)} className="space-y-3">
              {mode === "signup" ? (
                <>
                  <input
                    className={inputClass}
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Family name (e.g. The Peaks)"
                    value={householdName}
                    onChange={(e) => setHouseholdName(e.target.value)}
                  />
                </>
              ) : null}

              <input
                className={inputClass}
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
              <input
                className={inputClass}
                type="password"
                placeholder={mode === "signup" ? "Create a password" : "Password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                minLength={6}
                required
              />

              {mode === "signup" ? (
                <input
                  className={cn(inputClass, "uppercase tracking-widest")}
                  placeholder="Activation code"
                  value={activationCode}
                  onChange={(e) => setActivationCode(e.target.value)}
                  required
                />
              ) : null}

              {error ? (
                <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
                  {error}
                </p>
              ) : null}

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                {mode === "signup" ? "Activate hub" : "Sign in"}
              </button>

              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setMode(mode === "signup" ? "signin" : "signup")
                }}
                className="w-full text-center text-sm font-medium text-muted-foreground"
              >
                {mode === "signup" ? "Already have an account? Sign in" : "Setting up a new family? Create one"}
              </button>
            </form>
          )}
        </div>
      </div>
    </main>
  )
}
