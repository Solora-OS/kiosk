import { useEffect, useRef } from "react"
import { useSeason } from "@/components/season-provider"
import { useTheme } from "@/components/theme-provider"
import type { SeasonEffect } from "@/lib/seasons"

/**
 * Ambient particles for the active season. Sparse on purpose — a wall
 * display is looked at all day, so this should read as weather, not a
 * screensaver. Drawn over the page content (pointer-events off, see-through)
 * but only inside the app's content area: the element marked
 * [data-effects-area], minus anything marked [data-effects-avoid="top"] or
 * [data-effects-avoid="bottom"]. So the header, status bar, side nav and
 * bottom nav always stay clear. Kept identical in mobile/ and kiosk/.
 */

type P = { x: number; y: number; vx: number; vy: number; r: number; a: number; rot: number; vr: number; t: number }

const COUNT: Record<SeasonEffect, number> = { none: 0, snow: 56, leaves: 16, hearts: 11, embers: 28 }

/** The visible part of the content area, clear of the header and bottom nav. */
function effectsBox(): { left: number; top: number; width: number; height: number } {
  let left = 0, top = 0, right = window.innerWidth, bottom = window.innerHeight
  const area = document.querySelector("[data-effects-area]")?.getBoundingClientRect()
  if (area) {
    left = Math.max(left, area.left); right = Math.min(right, area.right)
    top = Math.max(top, area.top); bottom = Math.min(bottom, area.bottom)
  }
  document.querySelectorAll('[data-effects-avoid="top"]').forEach((el) => { top = Math.max(top, el.getBoundingClientRect().bottom) })
  document.querySelectorAll('[data-effects-avoid="bottom"]').forEach((el) => { bottom = Math.min(bottom, el.getBoundingClientRect().top) })
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
}

/** Resolve any CSS color (oklch, var()) to something canvas understands. */
function resolveColor(css: string): string {
  const el = document.createElement("span")
  el.style.color = css
  el.style.display = "none"
  document.body.appendChild(el)
  const c = getComputedStyle(el).color
  el.remove()
  return c
}

// Lucide's leaf and heart outlines (24×24), drawn centred at the origin.
const LEAF = new Path2D("M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z")
const LEAF_VEIN = new Path2D("M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12")
const HEART = new Path2D("M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5")

export function SeasonEffects({ density = 1 }: { density?: number }) {
  const { season, effectsOn } = useSeason()
  const { resolvedTheme } = useTheme()
  const ref = useRef<HTMLCanvasElement>(null)
  const effect = effectsOn ? season.effect : "none"

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || effect === "none") return
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    let w = 0
    let h = 0
    const resize = () => {
      const box = effectsBox()
      Object.assign(canvas.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` })
      if (Math.round(box.width) === w && Math.round(box.height) === h) return
      w = Math.round(box.width)
      h = Math.round(box.height)
      canvas.width = w * dpr
      canvas.height = h * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    window.addEventListener("resize", resize)
    // Scrolling (the page on a phone, the content pane on the wall) and layout
    // changes move the area, so follow it.
    window.addEventListener("scroll", resize, { capture: true, passive: true })
    const follow = setInterval(resize, 1000)

    const dark = document.documentElement.classList.contains("dark")
    const accent = resolveColor("var(--season)")
    const snow = dark ? "rgb(255,255,255)" : resolveColor("var(--muted-foreground)")

    const n = Math.round(COUNT[effect] * density)
    const spawn = (initial: boolean): P => {
      const rising = effect === "embers" || effect === "hearts"
      return {
        x: Math.random() * w,
        y: initial ? Math.random() * h : rising ? h + 10 : -10,
        vx: (Math.random() - 0.5) * 0.25,
        vy: rising ? -(0.15 + Math.random() * 0.35) : effect === "snow" ? 0.25 + Math.random() * 0.45 : 0.35 + Math.random() * 0.3,
        r: effect === "snow" ? 0.8 + Math.random() * 2 : effect === "embers" ? 0.8 + Math.random() * 1.4 : 0.9 + Math.random() * 0.6,
        a: 0.25 + Math.random() * 0.45,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.02,
        t: Math.random() * 1000,
      }
    }
    const ps = Array.from({ length: n }, () => spawn(true))

    let raf = 0
    let last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 16.7, 3)
      last = now
      ctx.clearRect(0, 0, w, h)
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i]
        p.t += dt
        p.x += (p.vx + Math.sin(p.t / 90) * 0.25) * dt
        p.y += p.vy * dt
        p.rot += p.vr * dt
        if (p.y > h + 20 || p.y < -20 || p.x < -20 || p.x > w + 20) ps[i] = spawn(false)

        ctx.save()
        ctx.translate(p.x, p.y)
        if (effect === "snow") {
          ctx.globalAlpha = p.a * (dark ? 0.8 : 0.5)
          ctx.fillStyle = snow
          ctx.beginPath()
          ctx.arc(0, 0, p.r, 0, Math.PI * 2)
          ctx.fill()
        } else if (effect === "embers") {
          ctx.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(p.t / 14))
          ctx.fillStyle = accent
          ctx.shadowColor = accent
          ctx.shadowBlur = 6
          ctx.beginPath()
          ctx.arc(0, 0, p.r, 0, Math.PI * 2)
          ctx.fill()
        } else {
          ctx.rotate(p.rot)
          ctx.scale(p.r * 0.55, p.r * 0.55)
          ctx.translate(-12, -12)
          ctx.globalAlpha = p.a * 0.7
          ctx.fillStyle = accent
          ctx.fill(effect === "leaves" ? LEAF : HEART)
          if (effect === "leaves") {
            ctx.strokeStyle = accent
            ctx.lineWidth = 1.2
            ctx.globalAlpha = p.a * 0.45
            ctx.stroke(LEAF_VEIN)
          }
        }
        ctx.restore()
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(follow)
      window.removeEventListener("resize", resize)
      window.removeEventListener("scroll", resize, { capture: true })
      ctx.clearRect(0, 0, w, h)
    }
  }, [effect, density, season.id, resolvedTheme])

  if (effect === "none") return null
  // Above cards, below the header, navs, sheets and dialogs (z-30 and up).
  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-20" />
}
