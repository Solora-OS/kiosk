import type { ReactNode } from "react"
import { toast, type ExternalToast } from "sonner"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"
import { SeasonMark } from "@/components/season/ornaments"

/*
 * Kiosk toasts — a slip of paper that slides in at the edge of the wall display.
 *
 * Kiosk-only: the phone app uses in-app banners + OS notifications instead.
 * Read from across a room and dismissed with a fingertip, so type is larger
 * than a desktop toast and the close target is a full 44px.
 *
 *   tone      leading notch          eyebrow
 *   success   season accent          Done
 *   info      muted                  System
 *   warning   season accent          Heads up
 *   error     destructive            Error
 *   notice    season accent + mark   Household  (messages sent from the app)
 */

type Tone = "success" | "info" | "warning" | "error" | "notice"

type Options = {
  description?: ReactNode
  action?: { label: string; onClick: () => void }
  duration?: number
  id?: ExternalToast["id"]
}

const EYEBROW: Record<Tone, string> = {
  success: "Done",
  info: "System",
  warning: "Heads up",
  error: "Error",
  notice: "Household",
}

function KioskToast({
  id,
  tone,
  title,
  description,
  action,
}: { id: string | number; tone: Tone; title: ReactNode } & Pick<Options, "description" | "action">) {
  const time = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className="relative flex w-[26rem] max-w-[calc(100vw-2rem)] items-start gap-4 overflow-hidden rounded-lg border border-hairline bg-popover py-4 pr-2 pl-6 text-popover-foreground shadow-[0_12px_32px_-16px_oklch(0_0_0/0.35)]"
    >
      {/* Leading notch — the only color on the slip */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-3 left-0 w-[3px] rounded-r-full",
          tone === "error" ? "bg-destructive" : tone === "info" ? "bg-muted-foreground/40" : "bg-season",
        )}
      />

      <div className="min-w-0 flex-1 pt-0.5">
        <p className={cn("os-label flex items-center gap-2", tone === "error" && "!text-destructive")}>
          {tone === "notice" ? <SeasonMark className="text-sm" /> : null}
          {EYEBROW[tone]}
          <span className="text-muted-foreground/60">· {time}</span>
        </p>
        <p className="mt-2 text-lg leading-snug font-medium text-balance">{title}</p>
        {description ? (
          <p className="mt-1 line-clamp-3 text-base leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
        {action ? (
          <button
            type="button"
            className="mt-3 -ml-1 inline-flex min-h-11 items-center rounded-md px-1 text-base font-medium text-season"
            onClick={() => {
              action.onClick()
              toast.dismiss(id)
            }}
          >
            {action.label}
          </button>
        ) : null}
      </div>

      <button
        type="button"
        aria-label="Dismiss"
        className="grid size-11 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors active:bg-secondary"
        onClick={() => toast.dismiss(id)}
      >
        <X className="size-5" />
      </button>
    </div>
  )
}

const DEFAULT_DURATION: Record<Tone, number> = {
  success: 4000,
  info: 5000,
  warning: 7000,
  error: 8000,
  notice: 10000,
}

function show(tone: Tone, title: ReactNode, opts: Options = {}) {
  const { description, action, duration, id } = opts
  return toast.custom(
    (tid) => <KioskToast id={tid} tone={tone} title={title} description={description} action={action} />,
    { id, duration: duration ?? DEFAULT_DURATION[tone] },
  )
}

export const kioskToast = {
  success: (title: ReactNode, opts?: Options) => show("success", title, opts),
  info: (title: ReactNode, opts?: Options) => show("info", title, opts),
  warning: (title: ReactNode, opts?: Options) => show("warning", title, opts),
  error: (title: ReactNode, opts?: Options) => show("error", title, opts),
  /** A message from someone in the household (central `notification:receive`). */
  notice: (title: ReactNode, opts?: Options) => show("notice", title, opts),
  dismiss: toast.dismiss,
}
