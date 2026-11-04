import { useEffect, useRef } from "react"
import { useTheme } from "@/components/theme-provider"

/**
 * Live weather inside the wall's weather tile: rain and drizzle fall, snow
 * drifts, storms add rain and a rare faint flash, fog rolls past. Clear and
 * cloudy skies stay still. Drawn on one small canvas behind the tile's text
 * and clipped to the tile, never the whole screen; nothing illustrated, just
 * the weather moving. Off with reduced motion and while the screen is hidden.
 *
 * Put it as the first child of a `relative isolate overflow-hidden` tile.
 */

type Kind = "none" | "drizzle" | "rain" | "heavy" | "snow" | "storm" | "fog"

/** WMO weather code (Open-Meteo) → what moves. */
export function motionKind(code: number): Kind {
  if (code === 45 || code === 48) return "fog"
  if (code >= 51 && code <= 57) return "drizzle"
  if (code === 65 || code === 67 || code === 82) return "heavy"
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "rain"
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow"
  if (code >= 95) return "storm"
  return "none"
}

const COUNT: Record<Kind, number> = { none: 0, drizzle: 26, rain: 46, heavy: 80, storm: 70, snow: 34, fog: 3 }

type P = { x: number; y: number; v: number; len: number; a: number; r: number; t: number }

export function WeatherMotion({ code }: { code: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const { resolvedTheme } = useTheme()
  const kind = motionKind(code)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || kind === "none") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let w = 0
    let h = 0
    const resize = () => {
      w = canvas.clientWidth
      h = canvas.clientHeight
      canvas.width = Math.max(1, w * dpr)
      canvas.height = Math.max(1, h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(canvas)

    const dark = document.documentElement.classList.contains("dark")
    // A soft rain blue: readable across a room on the light card, never louder than the text.
    const ink = dark ? "rgb(205,220,245)" : "rgb(96,124,168)"
    const haze = dark ? "rgb(220,228,240)" : "rgb(120,132,152)"
    const wet = kind === "drizzle" || kind === "rain" || kind === "heavy" || kind === "storm"
    const slant = 0.18 // rain leans a little, as if there's a breeze

    const spawn = (initial: boolean): P => ({
      x: Math.random() * (w + 40) - 20,
      y: initial ? Math.random() * h : -20 - Math.random() * 40,
      v: kind === "snow" ? 0.35 + Math.random() * 0.45
        : kind === "fog" ? 0.12 + Math.random() * 0.1
        : kind === "drizzle" ? 3 + Math.random() * 1.5 : 6 + Math.random() * 3,
      len: kind === "drizzle" ? 6 + Math.random() * 4 : 11 + Math.random() * 9,
      a: kind === "fog" ? 0.3 + Math.random() * 0.12 : 0.35 + Math.random() * 0.4,
      r: kind === "snow" ? 1.2 + Math.random() * 2.2 : kind === "fog" ? 0.6 + Math.random() * 0.4 : 0,
      t: Math.random() * 1000,
    })
    const ps = Array.from({ length: COUNT[kind] }, () => spawn(true))
    if (kind === "fog") ps.forEach((p, i) => { p.y = h * (0.25 + i * 0.25); p.x = Math.random() * w })

    let flash = 0
    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 16.7, 3)
      last = now
      ctx.clearRect(0, 0, w, h)

      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]
        p.t += dt
        if (wet) {
          p.y += p.v * dt
          p.x -= p.v * slant * dt
          if (p.y - p.len > h) ps[i] = spawn(false)
          ctx.globalAlpha = p.a * (dark ? 0.6 : 0.75)
          ctx.strokeStyle = ink
          ctx.lineWidth = kind === "drizzle" ? 1.2 : 1.6
          ctx.lineCap = "round"
          ctx.beginPath()
          ctx.moveTo(p.x, p.y)
          ctx.lineTo(p.x + p.len * slant, p.y - p.len)
          ctx.stroke()
        } else if (kind === "snow") {
          p.y += p.v * dt
          p.x += Math.sin(p.t / 60) * 0.35 * dt
          if (p.y - p.r > h) ps[i] = spawn(false)
          ctx.globalAlpha = p.a * (dark ? 1 : 0.85)
          ctx.fillStyle = ink
          ctx.beginPath()
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
          ctx.fill()
        } else if (kind === "fog") {
          p.x += p.v * dt
          if (p.x - w * 0.6 > w) p.x = -w * 0.6
          // A soft band: a round gradient squashed flat, so it fades out on every side.
          const rw = w * 0.6 * p.r * 1.6
          const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rw)
          g.addColorStop(0, haze)
          g.addColorStop(1, "rgba(0,0,0,0)")
          ctx.save()
          ctx.translate(p.x, p.y)
          ctx.scale(1, 0.3)
          ctx.globalAlpha = p.a
          ctx.fillStyle = g
          ctx.fillRect(-rw, -rw, rw * 2, rw * 2)
          ctx.restore()
        }
      }

      // Storms: now and then a faint, quick flash across the tile.
      if (kind === "storm") {
        if (flash <= 0 && Math.random() < 0.0025 * dt) flash = 1
        if (flash > 0) {
          ctx.globalAlpha = 0.18 * flash
          ctx.fillStyle = dark ? "rgb(220,230,255)" : "rgb(255,255,255)"
          ctx.fillRect(0, 0, w, h)
          flash -= 0.06 * dt
        }
      }
      ctx.globalAlpha = 1
      raf = requestAnimationFrame(tick)
    }

    const start = () => { last = performance.now(); raf = requestAnimationFrame(tick) }
    const onVisibility = () => { cancelAnimationFrame(raf); if (!document.hidden) start() }
    document.addEventListener("visibilitychange", onVisibility)
    start()

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [kind, resolvedTheme])

  if (kind === "none") return null
  return <canvas ref={ref} aria-hidden className="pointer-events-none absolute inset-0 -z-10 size-full" />
}
