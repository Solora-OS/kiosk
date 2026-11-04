"use client"

import { useState } from "react"
import { Apple, Sparkles } from "lucide-react"
import { WaveLoader } from "@/components/os/loading"
import { useAuth } from "@/lib/auth"
import { cn } from "@/lib/utils"
import { ClaimFlow } from "./claim-flow"

type Mode = "signin" | "signup"

const inputClass =
  "w-full rounded-xl border border-border bg-card px-3.5 py-3 text-sm outline-none transition-colors focus:border-primary"

export function AuthScreen() {
  const { signIn, signUp, appleEnabled, signInWithApple } = useAuth()
  const [mode, setMode] = useState<Mode>("signin")
  const [claiming, setClaiming] = useState(false)
  const [appleBusy, setAppleBusy] = useState(false)

  const [name, setName] = useState("")
  const [householdName, setHouseholdName] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [activationCode, setActivationCode] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (claiming) {
    return <ClaimFlow onCancel={() => setClaiming(false)} />
  }

  const handleApple = async () => {
    setError(null)
    setAppleBusy(true)
    try {
      await signInWithApple()
      // On success the browser redirects to Apple; control won't usually return here.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Apple sign-in failed.")
      setAppleBusy(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (mode === "signin") {
        await signIn({ email, password })
      } else {
        await signUp({ name, email, password, householdName: householdName || undefined, setupCode: activationCode })
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-background px-6 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
            <Sparkles className="size-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Welcome to Solora</h1>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            {mode === "signin"
              ? "Sign in to your family hub account."
              : "Create an account and enter the activation code shown on your hub's console to start your family hub."}
          </p>
        </div>

        {/* Mode toggle */}
        <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-secondary p-1">
          {(["signin", "signup"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m)
                setError(null)
              }}
              aria-pressed={mode === m}
              className={cn(
                "rounded-lg py-2 text-sm font-semibold transition-colors",
                mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
            >
              {m === "signin" ? "Sign in" : "Create account"}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === "signup" && (
            <>
              <input
                className={inputClass}
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
              <input
                className={inputClass}
                placeholder="Family name (optional)"
                value={householdName}
                onChange={(e) => setHouseholdName(e.target.value)}
              />
              <input
                className={cn(inputClass, "uppercase tracking-widest")}
                placeholder="Activation code"
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value)}
                required
              />
            </>
          )}
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
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signin" ? "current-password" : "new-password"}
            minLength={6}
            required
          />

          {error ? (
            <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>
          ) : null}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy ? <WaveLoader size={16} /> : null}
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>

        <div className="mt-6 flex items-center gap-3">
          <span className="h-px flex-1 bg-border" />
          <span className="text-xs font-medium text-muted-foreground">or</span>
          <span className="h-px flex-1 bg-border" />
        </div>

        {appleEnabled ? (
          <button
            type="button"
            onClick={handleApple}
            disabled={appleBusy}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-foreground py-3 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {appleBusy ? <WaveLoader size={16} /> : <Apple className="size-4" />}
            Continue with Apple
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setClaiming(true)}
          className="mt-3 w-full rounded-xl border border-border bg-card py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          I have an invite
        </button>


      </div>
    </main>
  )
}
