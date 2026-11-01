"use client"

import { useEffect, useRef, useState } from "react"
import { ChevronDown, Wifi, WifiHigh, WifiLow, WifiOff } from "lucide-react"
import { currentNetwork, scanNetworks } from "@/lib/wifi-service"
import { toggleControlCenter } from "@/components/os/control-center"
import { SeasonEdge, SeasonMark } from "@/components/season/ornaments"
import { useSeason } from "@/components/season-provider"
import { useDisplayPrefs } from "@/lib/display-prefs"

// ---------------------------------------------------------------------------
// Clock hook — ticks every second and returns the formatted time + date.
// ---------------------------------------------------------------------------
function useClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    // Align the first tick to the next whole second so the display is crisp.
    const msToNextSecond = 1000 - (Date.now() % 1000)
    let interval: ReturnType<typeof setInterval>
    const timeout = setTimeout(() => {
      setNow(new Date())
      interval = setInterval(() => setNow(new Date()), 1000)
    }, msToNextSecond)

    return () => {
      clearTimeout(timeout)
      clearInterval(interval)
    }
  }, [])

  const { clock24 } = useDisplayPrefs()
  const timeStr = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: !clock24,
  })

  const dateStr = now.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })

  return { timeStr, dateStr }
}

// ---------------------------------------------------------------------------
// WiFi hook — reads current SSID + signal every 15 s via wifi-service.
// ---------------------------------------------------------------------------
type WifiInfo = {
  ssid: string | null
  /** 0-100 or null when unknown */
  signal: number | null
}

function useWifi(): WifiInfo {
  const [info, setInfo] = useState<WifiInfo>({ ssid: null, signal: null })
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    async function poll() {
      try {
        const ssid = await currentNetwork()
        // Also grab signal from the scan list so we can show a quality icon.
        let signal: number | null = null
        if (ssid) {
          const nets = await scanNetworks()
          const match = nets.find((n) => n.ssid === ssid)
          signal = match?.signal ?? null
        }
        if (mountedRef.current) setInfo({ ssid, signal })
      } catch {
        /* non-fatal — keep last state */
      }
    }

    void poll()
    const id = setInterval(poll, 15_000)
    return () => {
      mountedRef.current = false
      clearInterval(id)
    }
  }, [])

  return info
}

// ---------------------------------------------------------------------------
// Signal icon
// ---------------------------------------------------------------------------
function WifiIcon({ ssid, signal }: { ssid: string | null; signal: number | null }) {
  if (!ssid) return <WifiOff className="size-3.5" aria-hidden />
  if (signal === null || signal >= 66) return <WifiHigh className="size-3.5" aria-hidden />
  if (signal >= 33) return <Wifi className="size-3.5" aria-hidden />
  return <WifiLow className="size-3.5" aria-hidden />
}

// ---------------------------------------------------------------------------
// SystemStatusBar
// ---------------------------------------------------------------------------
/**
 * The OS status strip (40px) at the top of every kiosk screen.
 *
 *   left   season name + mark (what the hub is "wearing")
 *   right  network · date · time — tap to drop the Control Center
 *
 * Seasonal edge decoration (string lights, a spider…) hangs from its hairline.
 */
export function SystemStatusBar({ label }: { label?: string }) {
  const { timeStr, dateStr } = useClock()
  const { ssid, signal } = useWifi()
  const { season } = useSeason()

  return (
    <div role="status" aria-live="polite" className="relative z-30 h-12 w-full shrink-0 border-b border-hairline bg-background">
      <div className="flex h-full items-center justify-between pl-5 pr-2">
        <div className="flex min-w-0 items-center gap-2 os-label">
          <SeasonMark className="text-[0.85rem]" />
          <span className="truncate">{label ?? season.name}</span>
        </div>

        <button
          type="button"
          onClick={toggleControlCenter}
          aria-label="Open control center"
          className="flex h-12 items-center gap-4 rounded-none px-4 text-muted-foreground transition-colors hover:bg-secondary active:bg-accent"
        >
          <span className="flex items-center gap-1.5 os-label">
            <WifiIcon ssid={ssid} signal={signal} />
            <span className="max-w-[10rem] truncate">{ssid ?? "Offline"}</span>
          </span>
          <span className="hidden os-label sm:inline">{dateStr}</span>
          <span className="font-mono text-[0.95rem] font-medium tabular text-foreground">{timeStr}</span>
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </div>
      <SeasonEdge />
    </div>
  )
}
