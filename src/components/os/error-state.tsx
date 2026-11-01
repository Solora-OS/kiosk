import { Component, type ReactNode } from "react"
import { RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { SeasonCorner } from "@/components/season/ornaments"

/*
 * Error moments — same voice as the rest of Lumora: quiet, editorial, honest.
 *
 *   inline  sits inside a view (a failed load, a failed save). Hairline frame,
 *           a destructive dot as the only alarm, one retry.
 *   screen  takes over the whole viewport (a crashed view, no hub). Set left
 *           and low like a system screen, with the season's corner artwork so
 *           an error still feels like *this* household's hub.
 *
 * Color stays restrained on purpose: destructive is a 6px dot and an eyebrow,
 * never a red slab.
 */

type ErrorKind = "network" | "auth" | "notFound" | "timeout" | "unknown"

const COPY: Record<ErrorKind, { title: string; hint: string }> = {
  network: { title: "Can't reach the hub.", hint: "Check the Wi-Fi in Control Center. This display reconnects on its own." },
  auth: { title: "You've been signed out.", hint: "Pair this display again from the Solora app on your phone." },
  notFound: { title: "That's not here anymore.", hint: "It may have been moved or removed by someone else in the family." },
  timeout: { title: "That took too long.", hint: "The hub is slow to answer. Give it a moment and try again." },
  unknown: { title: "Something went sideways.", hint: "Try again. If it keeps happening, restart the hub from Settings." },
}

/** Turn whatever was thrown into a kind + friendly copy (raw message kept as detail). */
export function describeError(err: unknown): { kind: ErrorKind; title: string; hint: string; detail?: string } {
  const detail = err instanceof Error ? err.message : typeof err === "string" ? err : undefined
  const m = (detail ?? "").toLowerCase()
  const kind: ErrorKind =
    /network|failed to fetch|offline|econnrefused|unreachable|load failed/.test(m) ? "network"
    : /401|403|unauthori[sz]ed|forbidden|expired|sign in/.test(m) ? "auth"
    : /404|not found/.test(m) ? "notFound"
    : /timeout|timed out|abort/.test(m) ? "timeout"
    : "unknown"
  return { kind, ...COPY[kind], detail }
}

type ErrorStateProps = {
  error?: unknown
  /** Overrides the friendly headline derived from `error`. */
  title?: ReactNode
  /** Overrides the supporting line derived from `error`. */
  hint?: ReactNode
  onRetry?: () => void
  retryLabel?: string
  variant?: "inline" | "screen"
  className?: string
}

export function ErrorState({
  error,
  title,
  hint,
  onRetry,
  retryLabel = "Try again",
  variant = "inline",
  className,
}: ErrorStateProps) {
  const d = describeError(error)
  const body = (
    <div className={cn("rise-in", variant === "screen" ? "max-w-2xl" : "max-w-xl")}>
      <p className="os-label flex items-center gap-2 !text-destructive">
        <span aria-hidden className="size-1.5 rounded-full bg-destructive" />
        {d.kind === "network" ? "Offline" : "Error"}
      </p>
      <h2
        className={cn(
          "font-display mt-4 text-balance leading-[1.02]",
          variant === "screen" ? "text-7xl" : "text-4xl",
        )}
      >
        {title ?? d.title}
      </h2>
      <p className="mt-4 text-pretty text-lg leading-relaxed text-muted-foreground">{hint ?? d.hint}</p>
      {d.detail && d.detail !== (title ?? d.title) ? (
        <p className="mt-4 truncate font-mono text-[0.75rem] text-muted-foreground/70" title={d.detail}>
          {d.detail}
        </p>
      ) : null}
      {onRetry ? (
        <button type="button" className="os-button mt-6" onClick={onRetry}>
          <RotateCw className="size-4" />
          {retryLabel}
        </button>
      ) : null}
    </div>
  )

  if (variant === "screen") {
    return (
      <div
        role="alert"
        className={cn(
          "relative flex min-h-dvh flex-col justify-end overflow-hidden bg-background px-10 pb-16",
          className,
        )}
      >
        <div aria-hidden className="paper-grid pointer-events-none absolute inset-0 opacity-70" />
        <SeasonCorner className="size-[26rem] opacity-40" />
        <div className="relative z-10">{body}</div>
      </div>
    )
  }

  return (
    <div role="alert" className={cn("my-6 rounded-lg border border-hairline bg-card px-8 py-8", className)}>
      {body}
    </div>
  )
}

/** Catches render crashes in a subtree and shows an ErrorState instead of a blank screen. */
export class ErrorBoundary extends Component<
  { children: ReactNode; variant?: "inline" | "screen"; resetKey?: unknown },
  { error: unknown }
> {
  state = { error: null as unknown }
  static getDerivedStateFromError(error: unknown) {
    return { error }
  }
  componentDidUpdate(prev: { resetKey?: unknown }) {
    // Navigating away (e.g. switching tabs) clears a stale crash.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null })
  }
  render() {
    if (this.state.error) {
      return (
        <ErrorState
          error={this.state.error}
          variant={this.props.variant}
          onRetry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}
