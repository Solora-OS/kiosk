"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, ChevronLeft } from "lucide-react"
import { WaveLoader } from "@/components/os/loading"
import { WifiStep } from "./wifi-step"
import { applyLocaleSettings, type ScreenOrientation } from "@/lib/locale-service"
import { currentNetwork } from "@/lib/wifi-service"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"

export type SetupValues = {
  language: string
  timezone: string
  deviceName: string
  orientation: ScreenOrientation
}

type StepId = "language" | "wifi" | "timezone" | "orientation" | "name"

const STEPS: { id: StepId; short: string; title: string; subtitle: string }[] = [
  { id: "language", short: "Language", title: "Hello.", subtitle: "Pick the language this hub speaks." },
  { id: "wifi", short: "Network", title: "Get online.", subtitle: "Choose your home Wi‑Fi. Solora only needs it once." },
  { id: "timezone", short: "Time zone", title: "Where is home?", subtitle: "So every schedule lands on the right hour." },
  { id: "orientation", short: "Mounting", title: "Which way is up?", subtitle: "Tell us how the screen hangs on the wall." },
  { id: "name", short: "Name", title: "Name this hub.", subtitle: "Something the whole family will recognize." },
]

const HELLOS = ["Hello.", "Hola.", "Bonjour.", "Hallo.", "Olá.", "こんにちは。", "你好。"]

const ORIENTATIONS: { value: ScreenOrientation; label: string; description: string; deg: number }[] = [
  { value: "normal",   label: "Landscape",         description: "Standard horizontal mount",     deg: 0   },
  { value: "left",     label: "Portrait, left",    description: "Rotated 90° counter‑clockwise", deg: -90 },
  { value: "right",    label: "Portrait, right",   description: "Rotated 90° clockwise",         deg: 90  },
  { value: "inverted", label: "Landscape, flipped", description: "Upside‑down horizontal mount",  deg: 180 },
]

const LANGUAGES = [
  { code: "en-US", label: "English", region: "United States" },
  { code: "en-GB", label: "English", region: "United Kingdom" },
  { code: "es-ES", label: "Español", region: "España" },
  { code: "fr-FR", label: "Français", region: "France" },
  { code: "de-DE", label: "Deutsch", region: "Deutschland" },
  { code: "pt-BR", label: "Português", region: "Brasil" },
  { code: "ja-JP", label: "日本語", region: "日本" },
  { code: "zh-CN", label: "中文", region: "中国" },
]

const NAME_SUGGESTIONS = ["Kitchen Hub", "Living Room", "Family Hub", "Hallway", "Office"]

/** A curated timezone list plus the device's detected zone, deduped. */
function useTimezones() {
  return useMemo(() => {
    const curated = [
      "America/Los_Angeles",
      "America/Denver",
      "America/Chicago",
      "America/New_York",
      "America/Sao_Paulo",
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Asia/Kolkata",
      "Australia/Sydney",
    ]
    let detected = ""
    try {
      detected = Intl.DateTimeFormat().resolvedOptions().timeZone
    } catch {
      detected = ""
    }
    const all = detected && !curated.includes(detected) ? [detected, ...curated] : curated
    return { list: all, detected }
  }, [])
}

/** Cycles through greetings on the language step — a quiet nod to the choice. */
function useHello(active: boolean) {
  const [i, setI] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setI((n) => (n + 1) % HELLOS.length), 2200)
    return () => clearInterval(t)
  }, [active])
  return HELLOS[i]
}

/** Live local time for a zone, refreshed each minute. */
function useZoneClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])
  return (tz: string) => {
    try {
      return now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", timeZone: tz })
    } catch {
      return ""
    }
  }
}

/** A tiny drawing of the panel, rotated, with its "top" edge marked. */
function ScreenGlyph({ deg, active }: { deg: number; active: boolean }) {
  return (
    <div className="flex size-28 items-center justify-center">
      <div
        className={`relative h-16 w-24 rounded-[4px] border-2 transition-colors ${active ? "border-foreground" : "border-muted-foreground/50"}`}
        style={{ transform: `rotate(${deg}deg)` }}
      >
        <span className={`absolute inset-x-2 top-1.5 h-[3px] rounded-full ${active ? "bg-season" : "bg-muted-foreground/40"}`} />
      </div>
    </div>
  )
}

/**
 * Device setup wizard — startup step 3. Collects language, WiFi, timezone and
 * device name, then hands the values to the caller to persist (local + cloud).
 */
export function SetupWizard({
  defaults,
  saving,
  saveError,
  onComplete,
}: {
  defaults: Partial<SetupValues>
  saving: boolean
  saveError: string | null
  onComplete: (values: SetupValues) => void
}) {
  const { list: timezones, detected } = useTimezones()
  const [stepIdx, setStepIdx] = useState(0)
  const step = STEPS[stepIdx]

  const [language, setLanguage] = useState(defaults.language ?? "en-US")
  const [connectedSsid, setConnectedSsid] = useState<string | null>(null)

  // Pre-populate connectedSsid if Linux is already on a network when setup starts.
  useEffect(() => {
    void currentNetwork().then((ssid) => { if (ssid) setConnectedSsid(ssid) })
  }, [])
  const [timezone, setTimezone] = useState(defaults.timezone ?? detected ?? "America/New_York")
  const [orientation, setOrientation] = useState<ScreenOrientation>(
    (defaults.orientation as ScreenOrientation | undefined) ?? "normal",
  )
  const [deviceName, setDeviceName] = useState(defaults.deviceName ?? "")

  const isLast = stepIdx === STEPS.length - 1
  const canAdvance = step.id === "name" ? deviceName.trim().length > 0 : true

  const next = async () => {
    if (isLast) {
      // Apply language and timezone to the OS before persisting setup values.
      // Errors are non-fatal — the wizard completes either way; the caller can
      // surface locale apply failures through saveError if needed.
      await applyLocaleSettings({ language, timezone, orientation }).catch((err) => {
        console.error("[setup-wizard] applyLocaleSettings failed:", err)
      })
      onComplete({ language, timezone, orientation, deviceName: deviceName.trim() })
      return
    }
    setStepIdx((i) => Math.min(i + 1, STEPS.length - 1))
  }
  const back = () => setStepIdx((i) => Math.max(i - 1, 0))

  const hello = useHello(step.id === "language")
  const zoneTime = useZoneClock()
  const title = step.id === "language" ? hello : step.title

  return (
    <main className="flex h-dvh flex-col bg-background text-foreground">
      <SystemStatusBar label="Setup" />

      <div className="grid min-h-0 flex-1 grid-rows-[auto_1fr] lg:landscape:grid-cols-[minmax(21rem,36%)_1fr] lg:landscape:grid-rows-1">
        {/* ── Left: where you are ─────────────────────────────── */}
        <aside className="relative flex flex-col justify-between gap-8 overflow-hidden border-b border-hairline px-10 py-9 lg:landscape:border-b-0 lg:landscape:border-r">
          <ol className="hidden flex-col gap-3 lg:landscape:flex">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={`flex items-center gap-4 font-mono text-[0.85rem] tracking-wide transition-colors ${
                  i === stepIdx ? "text-foreground" : i < stepIdx ? "text-muted-foreground" : "text-muted-foreground/45"
                }`}
              >
                <span className="tabular w-6">{String(i + 1).padStart(2, "0")}</span>
                <span className="uppercase">{s.short}</span>
                {i < stepIdx ? <Check className="size-3.5" /> : null}
                {i === stepIdx ? <span className="size-1.5 rounded-full bg-season" /> : null}
              </li>
            ))}
          </ol>

          <div>
            <p className="font-display text-[7rem] leading-none text-muted-foreground/25 tabular lg:text-[9rem]">
              {String(stepIdx + 1).padStart(2, "0")}
            </p>
            <h1 key={title} className={`rise-in mt-2 whitespace-nowrap font-display leading-[0.95] ${step.id === "language" ? "text-5xl lg:text-6xl" : "text-6xl lg:text-7xl"}`}>{title}</h1>
            <p className="mt-5 max-w-sm text-pretty text-lg text-muted-foreground">{step.subtitle}</p>
          </div>
        </aside>

        {/* ── Right: the choice ───────────────────────────────── */}
        <section className="flex min-h-0 flex-col">
          <div key={step.id} className="rise-in min-h-0 flex-1 overflow-y-auto px-10 py-9 lg:px-14">
            {step.id === "language" ? (
              <div className="grid gap-x-10 sm:grid-cols-2">
                {LANGUAGES.map((l) => {
                  const active = l.code === language
                  return (
                    <button key={l.code} type="button" onClick={() => setLanguage(l.code)} aria-pressed={active} className="os-option">
                      <span className="text-xl font-medium">{l.label}</span>
                      <span className="os-label">{l.region}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {step.id === "wifi" ? (
              <WifiStep connectedSsid={connectedSsid} onConnected={(ssid) => setConnectedSsid(ssid)} onSkip={next} />
            ) : null}

            {step.id === "timezone" ? (
              <div className="grid gap-x-10 sm:grid-cols-2">
                {timezones.map((tz) => {
                  const active = tz === timezone
                  const city = tz.split("/").pop()?.replace(/_/g, " ") ?? tz
                  return (
                    <button key={tz} type="button" onClick={() => setTimezone(tz)} aria-pressed={active} className="os-option">
                      <span className="min-w-0">
                        <span className="block truncate text-xl font-medium">{city}</span>
                        <span className="os-label mt-1.5 block truncate">
                          {tz === detected ? "Detected · " : ""}
                          {tz.split("/")[0]}
                        </span>
                      </span>
                      <span className="shrink-0 font-mono text-sm tabular text-muted-foreground">{zoneTime(tz)}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {step.id === "orientation" ? (
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                {ORIENTATIONS.map((o) => {
                  const active = o.value === orientation
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => setOrientation(o.value)}
                      aria-pressed={active}
                      className={`flex flex-col items-start gap-4 rounded-md border p-5 text-left transition-colors ${
                        active ? "border-foreground bg-card" : "border-border hover:bg-secondary"
                      }`}
                    >
                      <ScreenGlyph deg={o.deg} active={active} />
                      <span>
                        <span className="block text-lg font-medium">{o.label}</span>
                        <span className="mt-1 block text-sm text-muted-foreground">{o.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : null}

            {step.id === "name" ? (
              <div className="flex max-w-2xl flex-col pt-6">
                <input
                  autoFocus
                  value={deviceName}
                  onChange={(e) => setDeviceName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canAdvance && !saving) void next()
                  }}
                  maxLength={40}
                  placeholder="Kitchen Hub"
                  className="os-field font-display !text-6xl"
                />
                <div className="mt-6 flex flex-wrap gap-x-6 gap-y-3">
                  {NAME_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setDeviceName(s)}
                      className="text-base text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {saveError ? <p className="mt-6 text-sm text-destructive">{saveError}</p> : null}
              </div>
            ) : null}
          </div>

          <footer className="flex h-20 shrink-0 items-center justify-between border-t border-hairline px-10 lg:px-14">
            <button type="button" onClick={back} disabled={stepIdx === 0 || saving} className="os-button-quiet">
              <ChevronLeft className="size-5" />
              Back
            </button>
            <button type="button" onClick={() => void next()} disabled={!canAdvance || saving} className="os-button">
              {saving ? <WaveLoader size={16} /> : null}
              {isLast ? (saving ? "Finishing" : "Finish setup") : "Continue"}
            </button>
          </footer>
        </section>
      </div>
    </main>
  )
}
