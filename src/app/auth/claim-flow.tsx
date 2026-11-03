"use client"

import { useCallback, useState } from "react"
import { ArrowLeft, QrCode as QrIcon, ScanLine } from "lucide-react"
import { OrbitLoader } from "@/components/os/orbit"
import { api, type Invite } from "@/lib/api"
import { useAuth } from "@/lib/auth"
import { memberBg, roleLabels, type MemberColor } from "@/lib/data"
import { cn } from "@/lib/utils"
import { QrScanner } from "@/components/ui/reusables/qr-scanner"

const inputClass =
  "w-full rounded-xl border border-border bg-card px-3.5 py-3 text-sm outline-none transition-colors focus:border-primary"

const colorOptions: MemberColor[] = ["coral", "amber", "teal", "blue", "pink", "green"]

/** Pull an invite token/code out of a scanned QR payload. */
function parseScanned(text: string): string {
  const raw = text.trim()
  try {
    const obj = JSON.parse(raw) as { token?: string; code?: string }
    if (obj.token) return obj.token
    if (obj.code) return obj.code
  } catch {
    /* not JSON */
  }
  const match = raw.match(/invite\/([^/?#]+)/i)
  if (match) return match[1]
  return raw
}

export function ClaimFlow({ onCancel }: { onCancel: () => void }) {
  const { claimInvite } = useAuth()
  const [step, setStep] = useState<"find" | "profile">("find")
  const [scanning, setScanning] = useState(false)
  const [code, setCode] = useState("")
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // profile fields
  const [name, setName] = useState("")
  const [dob, setDob] = useState("")
  const [color, setColor] = useState<MemberColor>("blue")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const lookup = useCallback(
    async (tokenOrCode: string) => {
      setError(null)
      setBusy(true)
      try {
        const found = await api.getInvite(tokenOrCode)
        if (!found) {
          setError("We couldn't find that invite. Check the code and try again.")
          return
        }
        setInvite(found)
        setName(found.memberName)
        setColor("blue")
        // Prefill the details the admin already entered for this member.
        if (found.email) setEmail(found.email)
        setStep("profile")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Something went wrong.")
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  const onScan = useCallback(
    (text: string) => {
      setScanning(false)
      void lookup(parseScanned(text))
    },
    [lookup],
  )

  const claim = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!invite) return
    setError(null)
    setBusy(true)
    try {
      await claimInvite({
        token: invite.token,
        name,
        email,
        password,
        dob: dob || undefined,
        color,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.")
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col bg-background px-6 py-10">
      <button
        type="button"
        onClick={step === "profile" ? () => setStep("find") : onCancel}
        className="mb-6 flex items-center gap-1.5 text-sm font-medium text-muted-foreground"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>

      <div className="mx-auto w-full max-w-sm">
        {step === "find" ? (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-bold tracking-tight">Join a family</h1>
              <p className="mt-1 text-sm text-muted-foreground text-pretty">
                Scan the QR code on the hub or enter the invite code.
              </p>
            </div>

            {scanning ? (
              <div className="space-y-3">
                <QrScanner active={scanning} onResult={onScan} />
                <button
                  type="button"
                  onClick={() => setScanning(false)}
                  className="w-full rounded-xl border border-border bg-card py-3 text-sm font-semibold"
                >
                  Cancel scan
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  setScanning(true)
                }}
                className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-border bg-card py-8 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
              >
                <ScanLine className="size-7 text-primary" />
                Scan QR code
              </button>
            )}

            <div className="mt-6">
              <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Or enter invite code</label>
              <div className="flex gap-2">
                <input
                  className={cn(inputClass, "flex-1 uppercase tracking-widest")}
                  placeholder="K3F-9Q2"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                <button
                  type="button"
                  onClick={() => void lookup(code)}
                  disabled={!code.trim() || busy}
                  className="flex items-center justify-center gap-1.5 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:opacity-50"
                >
                  {busy ? <OrbitLoader size={16} /> : <QrIcon className="size-4" />}
                  Find
                </button>
              </div>
            </div>

            {error ? (
              <p className="mt-4 rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="mb-6 text-center">
              <h1 className="text-2xl font-bold tracking-tight">Set up your profile</h1>
              {invite ? (
                <p className="mt-1 text-sm text-muted-foreground text-pretty">
                  You&apos;re joining <span className="font-semibold text-foreground">{invite.householdName}</span> as{" "}
                  {roleLabels[invite.role]}.
                </p>
              ) : null}
            </div>

            <form onSubmit={claim} className="space-y-3">
              <input
                className={inputClass}
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
              <input
                className={inputClass}
                type="date"
                value={dob}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDob(e.target.value)}
              />

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Pick your color</label>
                <div className="flex gap-2">
                  {colorOptions.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      aria-pressed={color === c}
                      onClick={() => setColor(c)}
                      className={cn(
                        "size-8 rounded-full transition-transform",
                        memberBg[c],
                        color === c ? "ring-2 ring-foreground ring-offset-2 ring-offset-background" : "hover:scale-105",
                      )}
                    />
                  ))}
                </div>
              </div>

              <div className="pt-1">
                <label className="mb-1.5 block text-xs font-semibold text-muted-foreground">Account details</label>
                <div className="space-y-3">
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
                    placeholder="Create a password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    minLength={6}
                    required
                  />
                </div>
              </div>

              {error ? (
                <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">{error}</p>
              ) : null}

              <button
                type="submit"
                disabled={busy}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {busy ? <OrbitLoader size={16} /> : null}
                Join family
              </button>
            </form>
          </>
        )}
      </div>
    </main>
  )
}
