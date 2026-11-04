import { useCallback, useEffect, useState, useSyncExternalStore } from "react"
import { Lock, MoonStar, Power, RefreshCw, RotateCw, Sparkles, SunMedium, Volume2, VolumeX, Wifi, WifiOff, X } from "lucide-react"
import { WaveLoader } from "@/components/os/loading"
import { cn } from "@/lib/utils"
import { useTheme, type Theme } from "@/components/theme-provider"
import { useSeason } from "@/components/season-provider"
import { SeasonPicker } from "@/components/ui/reusables/season-picker"
import { getAudio, getBrightness, power, setBrightness, setMuted, setVolume, sleepDisplay } from "@/lib/system-service"
import { scanNetworks, connect as wifiConnect, currentNetwork, needsPassword, type WifiNetwork } from "@/lib/wifi-service"
import { restartHub } from "@/lib/hub"
import { Fader, HoldButton, Segmented, useThrottled } from "./controls"

// ── Tiny global store so the status strip, rail, and settings can all open it ─

type OsUi = { open: boolean; asleep: boolean }
let ui: OsUi = { open: false, asleep: false }
const subs = new Set<() => void>()
const emit = (next: Partial<OsUi>) => {
  ui = { ...ui, ...next }
  subs.forEach((f) => f())
}
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}
export const openControlCenter = () => emit({ open: true })
export const closeControlCenter = () => emit({ open: false })
export const toggleControlCenter = () => emit({ open: !ui.open })
export const useOsUi = () => useSyncExternalStore(subscribe, () => ui)
/** Show or clear the black "asleep" layer (also used by remote commands). */
export const setAsleep = (asleep: boolean) => emit(asleep ? { asleep, open: false } : { asleep })

// ── Tiles ───────────────────────────────────────────────────────────────────
// The panel is a grid of tiles: quick toggles across the top, the two faders,
// then look (theme + season), Wi-Fi and power each in their own tile.

function Tile({ title, children, className }: { title?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-4 rounded-xl bg-card p-5", className)}>
      {title ? <h3 className="text-sm font-semibold text-muted-foreground">{title}</h3> : null}
      {children}
    </section>
  )
}

/** A square quick toggle: icon, name, and a one-word state. Lit when on. */
function Toggle({
  icon: Icon,
  label,
  state,
  on,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  state: string
  on?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-28 flex-col justify-between rounded-xl p-4 text-left transition-colors active:scale-[0.98]",
        on ? "bg-foreground text-background" : "bg-card text-foreground hover:bg-secondary",
      )}
    >
      <Icon className="size-6" />
      <span className="min-w-0">
        <span className="block truncate text-[0.95rem] font-semibold">{label}</span>
        <span className={cn("block truncate text-sm", on ? "text-background/70" : "text-muted-foreground")}>{state}</span>
      </span>
    </button>
  )
}

function QuickToggles({ wifiName, onWifi, wifiOpen }: { wifiName: string | null; onWifi: () => void; wifiOpen: boolean }) {
  const { effectsOn, setEffectsOn } = useSeason()
  const [muted, setMute] = useState(false)
  useEffect(() => {
    void getAudio().then((a) => setMute(a.muted))
  }, [])
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Toggle icon={wifiName ? Wifi : WifiOff} label="Wi-Fi" state={wifiName ?? "Not connected"} on={wifiOpen} onClick={onWifi} />
      <Toggle
        icon={muted ? VolumeX : Volume2}
        label="Sound"
        state={muted ? "Muted" : "On"}
        on={muted}
        onClick={() => {
          setMute(!muted)
          void setMuted(!muted)
        }}
      />
      <Toggle icon={Sparkles} label="Effects" state={effectsOn ? "Snow, leaves, embers" : "Off"} on={effectsOn} onClick={() => setEffectsOn(!effectsOn)} />
      <Toggle
        icon={MoonStar}
        label="Sleep screen"
        state="Touch to wake"
        onClick={() => {
          closeControlCenter()
          emit({ asleep: true })
          void sleepDisplay()
        }}
      />
    </div>
  )
}

function FaderTile({ icon: Icon, label, value, children }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string; children: React.ReactNode }) {
  return (
    <Tile>
      <div className="flex items-center gap-2.5">
        <Icon className="size-5 text-muted-foreground" />
        <span className="text-sm font-semibold text-muted-foreground">{label}</span>
        <span className="ml-auto font-display text-3xl leading-none tabular">{value}</span>
      </div>
      {children}
    </Tile>
  )
}

function VolumeTile() {
  const [vol, setVol] = useState(50)
  const [muted, setMute] = useState(false)
  useEffect(() => {
    void getAudio().then((a) => {
      setVol(a.volume)
      setMute(a.muted)
    })
  }, [])
  const push = useThrottled(setVolume)
  return (
    <FaderTile icon={Volume2} label="Volume" value={muted ? "—" : String(vol)}>
      <Fader
        label="Volume"
        value={muted ? 0 : vol}
        onChange={(v) => {
          setVol(v)
          if (muted) {
            setMute(false)
            void setMuted(false)
          }
          push(v)
        }}
      />
    </FaderTile>
  )
}

function BrightnessTile() {
  const [level, setLevel] = useState<number | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    void getBrightness().then((b) => {
      setLevel(b)
      setLoaded(true)
    })
  }, [])
  const push = useThrottled(setBrightness)
  return (
    <FaderTile icon={SunMedium} label="Brightness" value={level == null ? "—" : String(level)}>
      {loaded && level === null ? (
        <p className="flex h-14 items-center rounded-md border border-dashed border-border px-4 text-sm text-muted-foreground">
          Set on the monitor itself.
        </p>
      ) : (
        <Fader
          label="Brightness"
          min={5}
          value={level ?? 0}
          onChange={(v) => {
            setLevel(v)
            push(v)
          }}
        />
      )}
    </FaderTile>
  )
}

/** Light/dark and the season the wall is wearing, as one "look" tile. */
function LookTile() {
  const { theme, setTheme } = useTheme()
  const [seasonOpen, setSeasonOpen] = useState(false)
  return (
    <Tile title="Look" className="md:col-span-2">
      <Segmented<Theme>
        value={theme}
        onChange={setTheme}
        options={[
          { value: "light", label: "Paper" },
          { value: "dark", label: "Graphite" },
          { value: "system", label: "Auto" },
        ]}
      />
      <SeasonPicker open={seasonOpen} onOpenChange={setSeasonOpen} />
    </Tile>
  )
}

function WifiTile({ current, onCurrent }: { current: string | null; onCurrent: (ssid: string | null) => void }) {
  const [nets, setNets] = useState<WifiNetwork[]>([])
  const [scanning, setScanning] = useState(false)
  const [target, setTarget] = useState<WifiNetwork | null>(null)
  const [pwd, setPwd] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const scan = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      const [ssid, list] = await Promise.all([currentNetwork(), scanNetworks()])
      onCurrent(ssid)
      setNets(list.slice(0, 6))
    } catch (err) {
      setNets([])
      setError(err instanceof Error ? err.message : "Couldn't scan for networks.")
    } finally {
      setScanning(false)
    }
  }, [onCurrent])
  useEffect(() => {
    void scan()
  }, [scan])

  const join = async (net: WifiNetwork, password?: string) => {
    setBusy(true)
    setError(null)
    try {
      const ok = await wifiConnect(net.ssid, password)
      if (ok) {
        onCurrent(net.ssid)
        setTarget(null)
        setPwd("")
      } else setError("Wrong password, or the network refused.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't connect.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Tile className="md:col-span-2 animate-in fade-in slide-in-from-top-2 duration-200">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-muted-foreground">Wi-Fi networks</h3>
        <button
          type="button"
          onClick={() => void scan()}
          aria-label="Rescan"
          className="flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
        >
          <RefreshCw className={cn("size-4", scanning && "animate-spin")} />
        </button>
      </div>
      <ul>
        {nets
          .filter((n) => n.ssid !== current)
          .map((n) => (
            <li key={n.ssid} className="border-b border-hairline last:border-0">
              <button
                type="button"
                onClick={() => {
                  setError(null)
                  if (needsPassword(n.security)) setTarget(n)
                  else void join(n)
                }}
                className="flex h-14 w-full items-center gap-3 text-left text-[0.95rem]"
              >
                <Wifi className="size-4 text-muted-foreground" style={{ opacity: 0.35 + n.signal / 150 }} />
                <span className="flex-1 truncate">{n.ssid}</span>
                {needsPassword(n.security) ? <Lock className="size-3.5 text-muted-foreground" /> : null}
              </button>
              {target?.ssid === n.ssid ? (
                <form
                  className="flex items-center gap-2 pb-3"
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (pwd) void join(n, pwd)
                  }}
                >
                  <input
                    autoFocus
                    type="password"
                    value={pwd}
                    onChange={(e) => setPwd(e.target.value)}
                    placeholder="Password"
                    className="h-12 flex-1 rounded-md bg-secondary px-4 outline-none focus:ring-2 focus:ring-season/40"
                  />
                  <button type="submit" disabled={busy || !pwd} className="h-12 rounded-md bg-foreground px-5 font-medium text-background disabled:opacity-40">
                    {busy ? <WaveLoader size={16} /> : "Join"}
                  </button>
                </form>
              ) : null}
            </li>
          ))}
      </ul>
      {!scanning && !error && nets.filter((n) => n.ssid !== current).length === 0 ? (
        <p className="text-sm text-muted-foreground">No other networks nearby.</p>
      ) : null}
      {error ? <p className="text-sm text-muted-foreground">{error}</p> : null}
    </Tile>
  )
}

function PowerTile() {
  const [pending, setPending] = useState<string | null>(null)
  const run = (label: string, fn: () => Promise<void>) => {
    setPending(label)
    void fn().catch(() => setPending(null))
  }
  return (
    <Tile title="Power">
      <div className="grid gap-2">
        <HoldButton onConfirm={() => run("Restarting Solora", restartHub)}>
          <RotateCw className="size-4" /> Restart app
        </HoldButton>
        <HoldButton onConfirm={() => run("Rebooting", () => power("reboot"))}>
          <RefreshCw className="size-4" /> Reboot
        </HoldButton>
        <HoldButton tone="danger" onConfirm={() => run("Shutting down", () => power("poweroff"))}>
          <Power className="size-4" /> Shut down
        </HoldButton>
      </div>
      {pending ? <p className="text-sm text-muted-foreground">{pending}…</p> : null}
    </Tile>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

/**
 * The OS control center. Drops from the status strip. Everything a family
 * would otherwise need a Linux desktop for lives here.
 */
export function ControlCenter() {
  const { open } = useOsUi()
  const [mounted, setMounted] = useState(open)

  useEffect(() => {
    if (open) setMounted(true)
    else {
      const t = setTimeout(() => setMounted(false), 260)
      return () => clearTimeout(t)
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeControlCenter()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  if (!mounted) return null

  return (
    <div className="fixed inset-0 z-[200]">
      <div
        onClick={closeControlCenter}
        className={cn(
          "absolute inset-0 bg-black/35 transition-opacity duration-300",
          open ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        role="dialog"
        aria-label="Control center"
        className={cn(
          "absolute inset-x-0 top-0 max-h-[92dvh] overflow-y-auto border-b border-border bg-popover transition-transform duration-300 ease-[var(--ease-out-quart)]",
          open ? "translate-y-0" : "-translate-y-full",
        )}
      >
        <div className="mx-auto max-w-5xl px-8 pb-6 pt-5">
          <div className="mb-5 flex items-center justify-between">
            <p className="font-display text-2xl">Control</p>
            <button
              type="button"
              onClick={closeControlCenter}
              aria-label="Close"
              className="flex size-12 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary"
            >
              <X className="size-5" />
            </button>
          </div>

          <ControlGrid />
        </div>
        {/* Grab handle — tap to close */}
        <button type="button" onClick={closeControlCenter} aria-label="Close" className="flex h-10 w-full items-center justify-center">
          <span className="h-1 w-12 rounded-full bg-border" />
        </button>
      </div>
    </div>
  )
}

function ControlGrid() {
  const [wifiOpen, setWifiOpen] = useState(false)
  const [ssid, setSsid] = useState<string | null>(null)
  useEffect(() => {
    void currentNetwork().then(setSsid).catch(() => {})
  }, [])
  return (
    <div className="space-y-3">
      <QuickToggles wifiName={ssid} wifiOpen={wifiOpen} onWifi={() => setWifiOpen((v) => !v)} />
      {wifiOpen ? <div className="grid gap-3 md:grid-cols-2"><WifiTile current={ssid} onCurrent={setSsid} /></div> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <BrightnessTile />
        <VolumeTile />
      </div>
      <div className="grid gap-3 md:grid-cols-3">
        <LookTile />
        <PowerTile />
      </div>
    </div>
  )
}

/** Black layer shown while the display is "asleep". Any touch wakes it. */
export function SleepLayer() {
  const { asleep } = useOsUi()
  if (!asleep) return null
  return (
    <button
      type="button"
      aria-label="Wake display"
      onClick={() => emit({ asleep: false })}
      className="fixed inset-0 z-[10000] cursor-none bg-black"
    />
  )
}
