import { useId, useMemo } from "react"
import { Ghost, Heart, Leaf, Ribbon, Sparkles, Sprout, TreePine, Wheat, type LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { useSeason } from "@/components/season-provider"
import type { OrnamentKind } from "@/lib/seasons"

/*
 * Season ornaments.
 *
 *   SeasonMark    a 1em glyph beside the date / wordmark      (Lucide icons)
 *   SeasonEdge    hangs from the status strip: lights, spider (built SVG)
 *   SeasonCorner  large faint art for the top-right of a screen
 *
 * Glyphs and scattered corner art come from Lucide — the same icon set as the
 * rest of the UI. Lucide has no spider, web, or holiday bulb, so those are
 * constructed here geometrically (mirrored legs, a computed orb-web, gradient-
 * shaded bulbs and baubles) so they stay crisp at any panel size.
 *
 * Everything is pointer-events-none and aria-hidden: decoration, not content.
 */

const MARK: Partial<Record<OrnamentKind, LucideIcon>> = {
  web: Ghost,
  ribbon: Ribbon,
  leaves: Wheat,
  hearts: Heart,
  stars: Sparkles,
  sprout: Sprout,
  lights: TreePine,
}

export function SeasonMark({ className }: { className?: string }) {
  const { season } = useSeason()
  const Icon = MARK[season.ornament]
  if (!Icon) return null
  return (
    <Icon
      aria-hidden
      strokeWidth={1.75}
      className={cn("pointer-events-none size-[1em] shrink-0 text-season", className)}
    />
  )
}

// ── Seeded jitter so organic shapes are identical on every render ───────────

function rng(seed: number) {
  let s = seed
  return () => {
    s = (s * 16807) % 2147483647
    return (s - 1) / 2147483646
  }
}

// ── String lights (C9 bulbs) ────────────────────────────────────────────────

const BULBS = [
  { id: "red", hi: "oklch(0.86 0.12 30)", mid: "oklch(0.62 0.21 27)", lo: "oklch(0.42 0.16 25)" },
  { id: "amber", hi: "oklch(0.96 0.08 95)", mid: "oklch(0.82 0.15 80)", lo: "oklch(0.62 0.14 60)" },
  { id: "green", hi: "oklch(0.9 0.1 150)", mid: "oklch(0.62 0.15 152)", lo: "oklch(0.42 0.11 155)" },
  { id: "blue", hi: "oklch(0.9 0.07 240)", mid: "oklch(0.62 0.15 255)", lo: "oklch(0.42 0.13 262)" },
  { id: "white", hi: "oklch(1 0 0)", mid: "oklch(0.96 0.03 90)", lo: "oklch(0.8 0.05 85)" },
]

/** Bulb silhouette: a C9 cone with a rounded nose, socket at y=0. */
const BULB_PATH = "M-3.6 0 C-4.6 3.4 -5.2 7.2 -4.6 10.6 C-4 14 -1.8 16.4 0 17.2 C1.8 16.4 4 14 4.6 10.6 C5.2 7.2 4.6 3.4 3.6 0 Z"

function StringLights() {
  const uid = useId().replace(/:/g, "")
  const tiles = useMemo(() => Array.from({ length: 40 }, (_, i) => i), [])
  return (
    <div className="flex h-8 overflow-hidden">
      {/* Shared gradients for every tile */}
      <svg width="0" height="0" className="absolute">
        <defs>
          {BULBS.map((b) => (
            <radialGradient key={b.id} id={`${uid}-${b.id}`} cx="0.38" cy="0.62" r="0.75">
              <stop offset="0" stopColor={b.hi} />
              <stop offset="0.45" stopColor={b.mid} />
              <stop offset="1" stopColor={b.lo} />
            </radialGradient>
          ))}
          <linearGradient id={`${uid}-socket`} x1="0" x2="1">
            <stop offset="0" stopColor="oklch(0.32 0.03 150)" />
            <stop offset="0.5" stopColor="oklch(0.48 0.04 150)" />
            <stop offset="1" stopColor="oklch(0.28 0.03 150)" />
          </linearGradient>
        </defs>
      </svg>
      {tiles.map((i) => {
        const b = BULBS[i % BULBS.length]
        const tilt = ((i * 37) % 17) - 8 // −8°…+8°, deterministic
        return (
          <svg key={i} viewBox="0 0 80 32" className="h-8 w-20 shrink-0 overflow-visible" aria-hidden>
            {/* Twisted green wire: two strands */}
            <path d="M0 1.5 Q40 11 80 1.5" fill="none" stroke="oklch(0.38 0.05 150)" strokeWidth="1.4" />
            <path d="M0 2.4 Q40 11.8 80 2.4" fill="none" stroke="oklch(0.3 0.04 150)" strokeWidth=".8" strokeDasharray="3 2" />
            <g transform={`translate(40 6.6) rotate(${tilt})`}>
              {/* Socket with ridges */}
              <rect x="-3.4" y="0" width="6.8" height="6" rx="1" fill={`url(#${uid}-socket)`} />
              <path d="M-3.4 2h6.8M-3.4 4h6.8" stroke="oklch(0.22 0.02 150)" strokeWidth=".5" />
              {/* Glow + glass */}
              <g transform="translate(0 5.6)" className="twinkle" style={{ animationDelay: `${(i * 0.53) % 3.2}s` }}>
                <ellipse cx="0" cy="10" rx="9" ry="11" fill={b.mid} opacity=".28" style={{ filter: "blur(4px)" }} />
                <path d={BULB_PATH} fill={`url(#${uid}-${b.id})`} />
                {/* Specular highlight */}
                <path d="M-2.2 3 C-2.9 6 -2.9 9 -2 11.4" fill="none" stroke="white" strokeOpacity=".7" strokeWidth="1" strokeLinecap="round" />
              </g>
            </g>
          </svg>
        )
      })}
    </div>
  )
}

// ── Spider (hangs head-down on its dragline) ────────────────────────────────

/** Right-side legs as [coxa, knee, ankle, tip]; the left side is mirrored. */
const LEGS: [number, number][][] = [
  [[65.5, 77], [80, 86], [87, 103], [90, 121]], // I   (front, reaching down)
  [[67, 73], [86, 75], [98, 90], [106, 105]], // II
  [[67, 69], [85, 59], [99, 64], [110, 75]], // III
  [[65.5, 65], [80, 48], [90, 36], [101, 27]], // IV  (back, reaching up)
]

function Spider({ className }: { className?: string }) {
  const uid = useId().replace(/:/g, "")
  const mirror = (p: [number, number]): [number, number] => [120 - p[0], p[1]]
  const legs = [...LEGS, ...LEGS.map((l) => l.map(mirror))]
  const widths = [2.6, 1.9, 1.2]

  return (
    <svg viewBox="0 -60 120 190" className={className} aria-hidden>
      <defs>
        <radialGradient id={`${uid}-abd`} cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="color-mix(in oklch, var(--foreground) 45%, var(--background))" />
          <stop offset="0.55" stopColor="color-mix(in oklch, var(--foreground) 85%, var(--background))" />
          <stop offset="1" stopColor="var(--foreground)" />
        </radialGradient>
        <radialGradient id={`${uid}-ceph`} cx="0.4" cy="0.35" r="0.75">
          <stop offset="0" stopColor="color-mix(in oklch, var(--foreground) 50%, var(--background))" />
          <stop offset="1" stopColor="var(--foreground)" />
        </radialGradient>
      </defs>

      {/* Dragline */}
      <line x1="60" y1="-60" x2="60" y2="31" stroke="currentColor" strokeOpacity=".55" strokeWidth=".6" />

      {/* Legs: three tapering segments each, round joints */}
      <g stroke="var(--foreground)" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {legs.map((leg, li) =>
          leg.slice(0, 3).map((p, si) => (
            <line key={`${li}-${si}`} x1={p[0]} y1={p[1]} x2={leg[si + 1][0]} y2={leg[si + 1][1]} strokeWidth={widths[si]} />
          )),
        )}
      </g>

      {/* Pedipalps */}
      <g stroke="var(--foreground)" strokeWidth="1.4" strokeLinecap="round" fill="none">
        <path d="M57 80 Q53 85 55 90" />
        <path d="M63 80 Q67 85 65 90" />
      </g>

      {/* Cephalothorax + abdomen */}
      <ellipse cx="60" cy="71" rx="8" ry="9.5" fill={`url(#${uid}-ceph)`} />
      <ellipse cx="60" cy="47" rx="13.5" ry="17" fill={`url(#${uid}-abd)`} />
      {/* Widow's hourglass in the season accent */}
      <path d="M60 47 L55.5 40 H64.5 Z M60 47 L55.5 54 H64.5 Z" fill="var(--season)" />
      {/* Eyes catching light */}
      <circle cx="57.6" cy="77.5" r=".9" fill="var(--background)" fillOpacity=".8" />
      <circle cx="62.4" cy="77.5" r=".9" fill="var(--background)" fillOpacity=".8" />
    </svg>
  )
}

export function SeasonEdge() {
  const { season } = useSeason()
  if (season.ornament === "lights") {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full z-40">
        <StringLights />
      </div>
    )
  }
  if (season.ornament === "web") {
    return (
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full z-40">
        <div className="sway absolute right-[18%] top-0 w-11 text-foreground opacity-80">
          <Spider className="h-auto w-full" />
        </div>
      </div>
    )
  }
  if (season.ornament === "ribbon") {
    return <div aria-hidden className="pointer-events-none absolute inset-x-0 top-full z-40 h-px bg-season/60" />
  }
  return null
}

// ── Corner art ──────────────────────────────────────────────────────────────

/** Orb web anchored in the top-right corner: radials, a back-and-forth
 *  capture spiral that sags between spokes, frame threads and dew. */
function Web() {
  const { radials, spiral, frame, dew } = useMemo(() => {
    const rand = rng(7)
    const cx = 240
    const cy = 0
    const n = 11
    const angles = Array.from({ length: n }, (_, i) => Math.PI / 2 + ((i + rand() * 0.25) * (Math.PI / 2)) / (n - 0.75))
    const pt = (a: number, r: number) => [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const
    const f = (v: number) => v.toFixed(1)

    const radials = angles.map((a) => {
      const [x, y] = pt(a, 300)
      return `M${cx} ${cy}L${f(x)} ${f(y)}`
    })

    // Capture thread: rings at slowly widening spacing, alternating direction,
    // joined at the ends so it reads as one continuous spiral.
    let d = ""
    const dewPts: [number, number, number][] = []
    let r = 16
    let dir = 1
    while (r < 232) {
      const order = dir > 0 ? angles : [...angles].reverse()
      order.forEach((a, i) => {
        const rr = r + (rand() - 0.5) * 2
        const [x, y] = pt(a, rr)
        if (i === 0) {
          d += d ? `L${f(x)} ${f(y)}` : `M${f(x)} ${f(y)}`
          return
        }
        const prev = order[i - 1]
        const [qx, qy] = pt((prev + a) / 2, rr * (0.9 + rand() * 0.03))
        d += `Q${f(qx)} ${f(qy)} ${f(x)} ${f(y)}`
        if (rand() > 0.9) dewPts.push([qx, qy, 0.9 + rand() * 1.3])
      })
      r += 9 + r * 0.06
      dir = -dir
    }

    const [ax, ay] = pt(angles[n - 1], 300)
    const [bx, by] = pt(angles[0], 300)
    const frame = `M${f(ax)} ${f(ay)}Q${f(cx - 150)} ${f(cy + 170)} ${f(bx)} ${f(by)}`

    return { radials, spiral: d, frame, dew: dewPts }
  }, [])

  return (
    <svg viewBox="0 0 240 240" className="size-full" fill="none" stroke="currentColor" strokeLinecap="round">
      <path d={frame} strokeWidth=".9" />
      {radials.map((d) => (
        <path key={d} d={d} strokeWidth=".8" />
      ))}
      <path d={spiral} strokeWidth=".55" />
      {dew.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill="currentColor" stroke="none" opacity=".9" />
      ))}
    </svg>
  )
}

/** Pine bough with twigs and two glass baubles in the season color. */
function PineBranch() {
  const uid = useId().replace(/:/g, "")
  const needles = useMemo(() => {
    const rand = rng(11)
    const out: { d: string; w: number }[] = []
    const bez = (t: number, p0: number[], p1: number[], p2: number[]) => [
      (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0],
      (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1],
    ]
    const stems = [
      { p: [[250, 26], [150, 6], [34, 64]], len: 22 },
      { p: [[170, 18], [150, 40], [118, 62]], len: 15 },
      { p: [[96, 40], [70, 34], [44, 26]], len: 13 },
      { p: [[210, 22], [196, 46], [176, 60]], len: 12 },
    ]
    for (const s of stems) {
      out.push({ d: `M${s.p[0].join(" ")}Q${s.p[1].join(" ")} ${s.p[2].join(" ")}`, w: s === stems[0] ? 1.8 : 1.2 })
      for (let t = 0.04; t < 0.98; t += 0.032) {
        const [x, y] = bez(t, s.p[0], s.p[1], s.p[2])
        const [x2, y2] = bez(Math.min(t + 0.01, 1), s.p[0], s.p[1], s.p[2])
        const ang = Math.atan2(y2 - y, x2 - x)
        const len = s.len * (1 - t * 0.45) * (0.85 + rand() * 0.3)
        for (const side of [-1, 1]) {
          const a = ang + side * (0.75 + rand() * 0.25)
          out.push({ d: `M${x.toFixed(1)} ${y.toFixed(1)}l${(Math.cos(a) * len).toFixed(1)} ${(Math.sin(a) * len).toFixed(1)}`, w: 0.9 })
        }
      }
    }
    return out
  }, [])

  const bauble = (x: number, top: number, hang: number, r: number, delay: string) => (
    <g className="sway" style={{ transformOrigin: `${x}px ${top}px`, animationDelay: delay }}>
      <line x1={x} y1={top} x2={x} y2={top + hang} stroke="currentColor" strokeWidth=".7" />
      <circle cx={x} cy={top + hang - 1.5} r="2" fill="none" stroke="oklch(0.75 0.06 85)" strokeWidth=".9" />
      <rect x={x - r * 0.32} y={top + hang} width={r * 0.64} height={r * 0.42} rx="1" fill={`url(#${uid}-cap)`} />
      <circle cx={x} cy={top + hang + r * 0.4 + r} r={r} fill={`url(#${uid}-glass)`} />
      <ellipse cx={x - r * 0.35} cy={top + hang + r * 0.4 + r * 0.6} rx={r * 0.22} ry={r * 0.32} fill="white" opacity=".55" transform={`rotate(-30 ${x - r * 0.35} ${top + hang + r * 0.4 + r * 0.6})`} />
    </g>
  )

  return (
    <svg viewBox="0 0 240 240" className="size-full" fill="none" strokeLinecap="round">
      <defs>
        <radialGradient id={`${uid}-glass`} cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="white" stopOpacity=".9" />
          <stop offset="0.25" stopColor="var(--season)" />
          <stop offset="1" stopColor="var(--season)" stopOpacity=".55" />
        </radialGradient>
        <linearGradient id={`${uid}-cap`} x1="0" x2="1">
          <stop offset="0" stopColor="oklch(0.62 0.07 85)" />
          <stop offset="0.5" stopColor="oklch(0.88 0.06 90)" />
          <stop offset="1" stopColor="oklch(0.55 0.06 80)" />
        </linearGradient>
      </defs>
      <g stroke="currentColor">
        {needles.map((n, i) => (
          <path key={i} d={n.d} strokeWidth={n.w} />
        ))}
      </g>
      {bauble(152, 24, 52, 15, "0s")}
      {bauble(94, 42, 30, 10, "-2s")}
    </svg>
  )
}

/** Lucide icons scattered as a loose sprig. Real icons, thin hairline strokes. */
function Scatter({ icon: Icon, accentFirst = true }: { icon: LucideIcon; accentFirst?: boolean }) {
  const spots = [
    { x: 58, y: 6, s: 30, r: -18 },
    { x: 34, y: 30, s: 22, r: 24 },
    { x: 70, y: 46, s: 18, r: 58 },
    { x: 14, y: 8, s: 14, r: -52 },
    { x: 50, y: 66, s: 13, r: 10 },
  ]
  return (
    <div className="relative size-full">
      {spots.map((p, i) => (
        <Icon
          key={i}
          absoluteStrokeWidth
          strokeWidth={1.1}
          className={cn("absolute", i === 0 && accentFirst ? "text-season" : "")}
          style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.s}%`, height: `${p.s}%`, transform: `rotate(${p.r}deg)` }}
        />
      ))}
    </div>
  )
}

export function SeasonCorner({ className }: { className?: string }) {
  const { season } = useSeason()
  let art: React.ReactNode = null
  switch (season.ornament) {
    case "web": art = <Web />; break
    case "lights": art = <PineBranch />; break
    case "ribbon":
      art = (
        <div className="flex size-full items-start justify-end p-[8%]">
          <Ribbon absoluteStrokeWidth strokeWidth={1.25} className="size-[70%] text-season" />
        </div>
      )
      break
    case "leaves": art = <Scatter icon={Leaf} />; break
    case "hearts": art = <Scatter icon={Heart} />; break
    case "stars": art = <Scatter icon={Sparkles} />; break
    case "sprout": art = <Scatter icon={Sprout} />; break
    case "custom":
      art = season.ornamentSvg ? (
        <img
          alt=""
          className="size-full object-contain"
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(season.ornamentSvg)}`}
        />
      ) : null
      break
  }
  if (!art) return null
  return (
    <div aria-hidden className={cn("pointer-events-none absolute right-0 top-0 size-60 text-foreground/25", className)}>
      {art}
    </div>
  )
}
