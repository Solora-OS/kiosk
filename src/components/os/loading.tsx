import { Fragment, type CSSProperties, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/**
 * The loader: a few bars in the text colour, rising and falling one after
 * another. No colour of its own, so it reads on paper, graphite and inside
 * filled buttons alike. Under 20px it drops to three bars.
 */
export function WaveLoader({ size = 28, label = "Loading", className }: { size?: number; label?: string; className?: string }) {
  const bars = size < 20 ? 3 : 5
  return (
    <span role="status" className={cn("wave inline-flex shrink-0 items-center", className)} style={{ height: size, width: size, gap: size / (bars === 3 ? 6 : 9) }}>
      {Array.from({ length: bars }, (_, i) => <i key={i} aria-hidden style={{ animationDelay: `${i * 120}ms` }} />)}
      <span className="sr-only">{label}</span>
    </span>
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
 * content shimmer in at once, and the screen frosts over with the wave loader
 * in the middle only if loading runs past ~600ms, so quick switches never flash it.
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
      <div aria-hidden className="wave-late pointer-events-none fixed inset-0 z-20 flex items-center justify-center bg-background/40 backdrop-blur-md">
        <WaveLoader size={wall ? 44 : 36} />
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
