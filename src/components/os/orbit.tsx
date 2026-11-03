import { Fragment, type CSSProperties, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The family orbit — the app icon's sun with the household circling it.
 * Same geometry as brand/orbit-icon.svg, recoloured with theme tokens so it
 * sits on paper or graphite: the sun takes the season accent, members are ink.
 */

// Resting positions in the 100×100 box (coral top, cream right, teal lower-left on the icon).
const MEMBERS = [
  { cx: 50, cy: 23, r: 7, className: "fill-foreground" },
  { cx: 77, cy: 50, r: 6, className: "fill-muted-foreground" },
  { cx: 31, cy: 69, r: 5, className: "fill-season/60" },
]

/**
 * Full mark. `animate` swings the members into orbit once, then lets the
 * family drift slowly — for splash screens, not for loading states.
 */
export function OrbitMark({ className, animate = false }: { className?: string; animate?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" aria-hidden className={cn("size-16 shrink-0", className)}>
      <circle cx="50" cy="50" r="27" fill="none" strokeWidth="2.5" className="stroke-muted-foreground/30" />
      <circle cx="50" cy="50" r="14" className="fill-season" />
      <g className={animate ? "orbit-drift" : undefined}>
        {MEMBERS.map((m, i) => (
          <g key={i} className={animate ? "orbit-settle" : undefined} style={animate ? { animationDelay: `${i * 120}ms` } : undefined}>
            <circle cx={m.cx} cy={m.cy} r={m.r} className={m.className} />
          </g>
        ))}
      </g>
    </svg>
  )
}

/**
 * Spinner: one member chasing round the sun with a fading trail. Detail drops
 * away as it shrinks — under 20px it's just the sun and a single dot. The
 * member takes the text colour, so it reads inside filled buttons too.
 */
export function OrbitLoader({ size = 28, label = "Loading", className }: { size?: number; label?: string; className?: string }) {
  const small = size < 20
  return (
    <span role="status" className={cn("inline-flex shrink-0", className)}>
      <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden>
        {small ? null : <circle cx="50" cy="50" r="34" fill="none" strokeWidth="6" className="stroke-season/20" />}
        <circle cx="50" cy="50" r={small ? 16 : 13} className="fill-season" />
        <g className="orbit-spin">
          <circle cx="50" cy={small ? 15 : 16} r={small ? 14 : 9} className="fill-current" />
          {small ? null : (
            <>
              <circle cx="30.5" cy="22.1" r="6" className="fill-current" opacity="0.5" />
              <circle cx="18.1" cy="38.4" r="4" className="fill-current" opacity="0.22" />
            </>
          )}
        </g>
      </svg>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/**
 * The app icon in plain ink, turning — the one loader that sits in the middle
 * of the screen while a tab's data loads.
 */
export function OrbitSpinner({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden className={cn("shrink-0 text-muted-foreground", className)}>
      <g className="orbit-spin-slow">
        <circle cx="50" cy="50" r="27" fill="none" strokeWidth="3" className="stroke-current" opacity="0.35" />
        <circle cx="50" cy="50" r="14" className="fill-current" />
        {MEMBERS.map((m, i) => <circle key={i} cx={m.cx} cy={m.cy} r={m.r} className="fill-current" opacity={[1, 0.7, 0.45][i]} />)}
      </g>
    </svg>
  )
}

type Bar = (className: string) => ReactNode

/** Placeholder layouts, each shaped like the tab it stands in for. */
const SHAPES: Record<string, (bar: Bar, wall: boolean) => ReactNode> = {
  home: (bar, wall) => wall ? (
    <div className="grid auto-rows-[11rem] grid-cols-4 gap-4">
      {["col-span-2 row-span-2", "", "", "col-span-2", "", "", "col-span-2", "", "", "col-span-2"].map((span, i) => (
        <Card key={i} className={span}>{bar("h-4 w-24")}{bar("h-8 w-3/5")}{bar("mt-auto h-3 w-4/5")}{span ? bar("h-3 w-2/3") : null}</Card>
      ))}
    </div>
  ) : (
    <>
      {bar("h-24 w-full rounded-lg")}
      {[3, 3, 1].map((rows, s) => (
        <div key={s} className="flex flex-col gap-2.5">
          {bar("h-4 w-24")}
          <Card>{Array.from({ length: rows }, (_, i) => <Row key={i} bar={bar} lead="h-9 w-12 rounded-md" />)}</Card>
        </div>
      ))}
      <div className="flex flex-col gap-2.5">
        {bar("h-4 w-20")}
        <div className="grid grid-cols-3 gap-2">{[0, 1, 2].map((i) => <Fragment key={i}>{bar("aspect-square w-full rounded-md")}</Fragment>)}</div>
      </div>
    </>
  ),
  calendar: (bar, wall) => (
    <>
      <div className="grid grid-cols-3 gap-3">{[0, 1, 2].map((i) => <Card key={i}>{bar("h-3 w-16")}{bar("h-6 w-10")}</Card>)}</div>
      {wall ? (
        <>
          <div className="flex items-center gap-4">{bar("h-10 w-56")}{bar("h-12 w-24 rounded-md")}<span className="flex-1" />{bar("h-12 w-24 rounded-md")}{bar("h-12 w-56 rounded-md")}</div>
          <div className="grid grid-cols-7 gap-2">
            {Array.from({ length: 35 }, (_, i) => (
              <div key={i} className="flex h-28 flex-col gap-2 rounded-md bg-card p-2">{bar("h-3 w-6")}{i % 3 === 0 ? bar("h-5 w-full rounded") : null}{i % 5 === 1 ? bar("h-5 w-4/5 rounded") : null}</div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex gap-3">{["w-28", "w-20", "w-24", "w-16"].map((w, i) => <Fragment key={i}>{bar(cn("h-8 rounded-full", w))}</Fragment>)}</div>
          <div className="grid grid-cols-7 gap-2">{Array.from({ length: 7 }, (_, i) => <Fragment key={i}>{bar("h-14 rounded-md")}</Fragment>)}</div>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex gap-3">{bar("h-4 w-12")}<Card className="flex-1">{bar(i % 2 ? "h-4 w-1/2" : "h-4 w-2/3")}{bar("h-3 w-1/3")}</Card></div>
          ))}
        </>
      )}
    </>
  ),
  chores: (bar) => (
    <>
      {bar("h-11 w-full rounded-lg")}
      <div className="flex items-center justify-between">{bar("h-3 w-36")}{bar("h-2 w-28 rounded-full")}</div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 7 }, (_, i) => <Card key={i} row><Row bar={bar} lead="size-10 rounded-full" tail="h-6 w-12 rounded-full" /></Card>)}
      </div>
    </>
  ),
  rewards: (bar) => (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, i) => <Card key={i}>{bar("size-14 rounded-xl")}{bar("h-4 w-2/3")}{bar("h-3 w-1/3")}{bar("mt-2 h-10 w-full rounded-md")}</Card>)}
    </div>
  ),
  lists: (bar) => (
    <>
      {[5, 0, 0, 0].map((items, i) => (
        <Card key={i}>
          <div className="flex items-center gap-2">{bar("size-3 rounded-full")}{bar(i % 2 ? "h-4 w-28" : "h-4 w-36")}<span className="flex-1" />{bar("h-5 w-10 rounded-full")}</div>
          {Array.from({ length: items }, (_, j) => (
            <div key={j} className="flex items-center gap-3 border-t border-hairline pt-3">{bar("size-5 rounded-md")}{bar(j % 2 ? "h-3.5 w-1/3" : "h-3.5 w-1/2")}</div>
          ))}
        </Card>
      ))}
    </>
  ),
  meals: (bar) => (
    <>
      {bar("h-20 w-full rounded-lg")}
      <div className="flex items-center justify-between">{bar("h-3.5 w-40")}{bar("h-8 w-28 rounded-full")}</div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 7 }, (_, i) => (
          <Card key={i}>{bar("h-6 w-16")}{bar("h-12 w-full rounded-md")}{i % 2 ? null : bar("h-12 w-full rounded-md")}</Card>
        ))}
      </div>
    </>
  ),
  photos: (bar) => (
    <>
      {bar("h-56 w-full rounded-lg")}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <Fragment key={i}>{bar("aspect-square w-full rounded-md")}</Fragment>)}</div>
    </>
  ),
}

function Card({ children, className, row }: { children: ReactNode; className?: string; row?: boolean }) {
  return <div className={cn("flex gap-3 rounded-lg bg-card p-4", row ? "items-center" : "flex-col", className)}>{children}</div>
}

function Row({ bar, lead, tail }: { bar: Bar; lead: string; tail?: string }) {
  return (
    <div className="flex w-full items-center gap-3">
      {bar(lead)}
      <div className="flex flex-1 flex-col gap-2">{bar("h-3.5 w-3/5")}{bar("h-3 w-2/5")}</div>
      {tail ? bar(tail) : null}
    </div>
  )
}

/**
 * What a tab shows while its data loads: placeholders shaped like that tab's
 * content shimmer in at once, and the spinning icon fades in at the middle of
 * the screen only if loading runs past ~600ms, so quick switches never flash it.
 * `wall` picks the wall display's wider layouts.
 */
export function TabLoading({ tab, wall = false, className }: { tab?: string; wall?: boolean; className?: string }) {
  let n = 0
  const bar: Bar = (c) => <div className={cn("skel rounded-md", c)} style={{ "--d": `${(n++ % 20) * 40}ms` } as CSSProperties} />
  const shape = SHAPES[tab ?? ""] ?? SHAPES.chores

  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col gap-5", className)}>
      <span className="sr-only">Loading</span>
      <div aria-hidden className="pointer-events-none flex select-none flex-col gap-5">{shape(bar, wall)}</div>
      <div aria-hidden className="pointer-events-none fixed inset-0 z-20 flex items-center justify-center">
        <div className="orbit-late flex items-center gap-3 rounded-2xl bg-card/90 px-5 py-4 shadow-lg ring-1 ring-hairline backdrop-blur">
          <OrbitSpinner size={wall ? 40 : 32} />
          <p className="os-label">Loading</p>
        </div>
      </div>
    </div>
  )
}

/**
 * Placeholder rows for a list inside a section (devices, links, events…),
 * shaped like the rows that will replace them. No spinner of its own.
 */
export function SkeletonRows({ rows = 3, lead = "size-7 rounded-md", className }: { rows?: number; lead?: string; className?: string }) {
  let n = 0
  const bar: Bar = (c) => <div className={cn("skel rounded-md", c)} style={{ "--d": `${(n++ % 20) * 40}ms` } as CSSProperties} />
  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col divide-y divide-hairline", className)}>
      <span className="sr-only">Loading</span>
      {Array.from({ length: rows }, (_, i) => <div key={i} aria-hidden className="py-3"><Row bar={bar} lead={lead} /></div>)}
    </div>
  )
}

/** A block-shaped placeholder (a photo, a QR code) that shimmers like the rest. */
export function SkeletonBlock({ className, label = "Loading" }: { className?: string; label?: string }) {
  return <div role="img" aria-label={label} className={cn("skel rounded-md", className)} />
}
