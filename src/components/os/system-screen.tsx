import { cn } from "@/lib/utils"
import { SystemStatusBar } from "@/components/ui/reusables/system-status-bar"
import { SeasonCorner } from "@/components/season/ornaments"
import { Wordmark } from "./wordmark"

/**
 * Frame for every full-screen system moment (boot, connecting, setup,
 * activation, pairing, maintenance). Content is set left and low, like the
 * title page of a book — never a logo floating in the middle of the screen.
 */
export function SystemScreen({
  children,
  footerRight,
  className,
  statusBar = true,
}: {
  children: React.ReactNode
  footerRight?: React.ReactNode
  className?: string
  statusBar?: boolean
}) {
  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {statusBar ? <SystemStatusBar /> : null}
      <div aria-hidden className="paper-grid pointer-events-none absolute inset-0 opacity-70" />
      <SeasonCorner className={cn("size-[26rem] opacity-40", statusBar && "top-12")} />

      <div className={cn("relative z-10 flex min-h-0 flex-1 flex-col", className)}>{children}</div>

      <footer className="relative z-10 flex h-16 shrink-0 items-center justify-between border-t border-hairline px-10">
        <Wordmark className="text-2xl" />
        <div className="os-label">{footerRight}</div>
      </footer>
    </main>
  )
}

/** Eyebrow + display headline + supporting copy, used on system screens. */
export function SystemHeading({
  eyebrow,
  title,
  children,
  className,
}: {
  eyebrow?: React.ReactNode
  title: React.ReactNode
  children?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("rise-in max-w-2xl", className)}>
      {eyebrow ? <p className="os-label mb-5">{eyebrow}</p> : null}
      <h1 className="font-display text-balance text-6xl leading-[0.95] lg:text-7xl">{title}</h1>
      {children ? <div className="mt-6 max-w-lg text-pretty text-lg leading-relaxed text-muted-foreground">{children}</div> : null}
    </div>
  )
}
