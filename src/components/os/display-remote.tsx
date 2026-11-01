import { useEffect, useRef } from "react"
import { useTheme } from "@/components/theme-provider"
import { useSeason } from "@/components/season-provider"
import { setAsleep, useOsUi } from "./control-center"
import { centralSocket } from "@/lib/central-socket"
import { liveSocket, reportDisplayState, type DisplayStateReport, type HubCommandPayload } from "@/lib/local-api"
import { getAudio, getBrightness, setBrightness, setMuted, setVolume, sleepDisplay, wakeDisplay } from "@/lib/system-service"
import { loadDeviceState } from "@/lib/device-state"
import { getDeviceToken } from "@/lib/kiosk-session"
import { addLog } from "@/lib/hub"

/** How often to re-read hardware values changed outside the app (Control Center, buttons). */
const POLL_MS = 20_000

/**
 * Lets a trusted phone run this display: applies display commands from the
 * hub (brightness, volume, theme, season, sleep) and reports the display's
 * current settings back so the phone always shows what's really on the wall.
 *
 * Restart / reload / cache / orientation / slideshow commands are handled by
 * the app shell; this only owns the display settings it can read back.
 */
export function DisplayRemote() {
  const { theme, setTheme } = useTheme()
  const { mode, setMode, effectsOn, setEffectsOn, seasons } = useSeason()
  const { asleep } = useOsUi()

  // Latest setters for the (mount-once) command listener.
  const act = useRef({ setTheme, setMode, setEffectsOn })
  act.current = { setTheme, setMode, setEffectsOn }

  // ── Report ────────────────────────────────────────────────────────────────
  const lastSent = useRef("")
  const ui = useRef({ theme, mode, effectsOn, seasons, asleep })
  ui.current = { theme, mode, effectsOn, seasons, asleep }

  const report = useRef(async () => {
    if (!getDeviceToken()) return
    const [audio, brightness, device] = await Promise.all([getAudio(), getBrightness(), loadDeviceState()])
    const u = ui.current
    const state: DisplayStateReport = {
      brightness,
      volume: audio.volume,
      muted: audio.muted,
      theme: u.theme,
      seasonMode: u.mode,
      seasonEffects: u.effectsOn,
      seasons: u.seasons.map((s) => ({ id: s.id, label: s.name })),
      orientation: device.orientation,
      slideshowIdleMins: device.slideshowIdleMins,
      asleep: u.asleep,
    }
    const json = JSON.stringify(state)
    if (json === lastSent.current) return
    try {
      await reportDisplayState(state)
      lastSent.current = json
    } catch {
      /* hub unreachable — the next poll retries */
    }
  })

  // Report whenever something the phone shows changes here…
  useEffect(() => {
    const t = setTimeout(() => void report.current(), 250)
    return () => clearTimeout(t)
  }, [theme, mode, effectsOn, seasons, asleep])

  // …and poll for hardware changes made outside the app.
  useEffect(() => {
    const t = setInterval(() => void report.current(), POLL_MS)
    return () => clearInterval(t)
  }, [])

  // ── Apply commands ────────────────────────────────────────────────────────
  useEffect(() => {
    // Commands arrive on both the hub socket and the cloud relay; run each once.
    let lastKey = ""
    let lastAt = 0

    const handle = (cmd: HubCommandPayload) => {
      const key = JSON.stringify(cmd)
      const now = Date.now()
      if (key === lastKey && now - lastAt < 1500) return
      lastKey = key
      lastAt = now

      let applied: Promise<unknown> | null = null
      switch (cmd.type) {
        case "set_brightness":
          applied = setBrightness(cmd.level)
          break
        case "set_volume":
          applied = setVolume(cmd.level)
          break
        case "set_muted":
          applied = setMuted(cmd.muted)
          break
        case "set_theme":
          act.current.setTheme(cmd.theme)
          break
        case "set_season":
          act.current.setMode(cmd.mode)
          break
        case "set_season_effects":
          act.current.setEffectsOn(cmd.on)
          break
        case "display_sleep":
          setAsleep(true)
          applied = sleepDisplay()
          break
        case "display_wake":
          setAsleep(false)
          applied = wakeDisplay()
          break
        case "set_orientation":
        case "set_idle_mins":
          // Applied by the app shell; report the new value once it's saved.
          applied = new Promise((r) => setTimeout(r, 400))
          break
        default:
          return
      }
      addLog("info", "system", `Remote: ${cmd.type.replace(/_/g, " ")}`)
      void Promise.resolve(applied).then(() => report.current())
    }

    const offCentral = centralSocket.onHubCommand(handle)
    const offLocal = liveSocket.subscribeHubCommand(handle)
    return () => {
      offCentral()
      offLocal()
    }
  }, [])

  return null
}
