import { useCallback, useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

/**
 * Hardware-feeling controls shared by the Control Center and Settings.
 */

/** A wide, thick touch fader. Drag anywhere on it; reports 0-100. */
export function Fader({
  value,
  onChange,
  disabled,
  label,
  min = 0,
}: {
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  label: string
  min?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const fromEvent = useCallback(
    (clientX: number) => {
      const el = ref.current
      if (!el) return
      const r = el.getBoundingClientRect()
      const v = Math.round(((clientX - r.left) / r.width) * 100)
      onChange(Math.max(min, Math.min(100, v)))
    },
    [onChange, min],
  )

  return (
    <div
      ref={ref}
      role="slider"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={100}
      aria-valuenow={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onChange(Math.min(100, value + 5))
        if (e.key === "ArrowLeft") onChange(Math.max(min, value - 5))
      }}
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture(e.pointerId)
        setDragging(true)
        fromEvent(e.clientX)
      }}
      onPointerMove={(e) => dragging && fromEvent(e.clientX)}
      onPointerUp={() => setDragging(false)}
      onPointerCancel={() => setDragging(false)}
      className={cn(
        "relative h-16 w-full cursor-pointer touch-none overflow-hidden rounded-[18px] bg-secondary outline-none",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <div
        className={cn("absolute inset-y-0 left-0 bg-foreground", !dragging && "transition-[width] duration-200")}
        style={{ width: `${value}%` }}
      />
      {/* Tick marks every 10% — reads like a physical scale */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-2 justify-between px-[1px]">
        {Array.from({ length: 11 }, (_, i) => (
          <span key={i} className="w-px bg-background/40 mix-blend-difference" />
        ))}
      </div>
      <span
        className="pointer-events-none absolute top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-background"
        style={{ left: `calc(${value}% - ${value > 2 ? 6 : -4}px)` }}
      />
    </div>
  )
}

/** Throttle rapid fader output to the OS (~12 calls/s) while keeping the UI live. */
export function useThrottled<T>(fn: (v: T) => void, ms = 80) {
  const last = useRef(0)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)
  return useCallback(
    (v: T) => {
      const now = Date.now()
      if (pending.current) clearTimeout(pending.current)
      if (now - last.current >= ms) {
        last.current = now
        fn(v)
      } else {
        pending.current = setTimeout(() => {
          last.current = Date.now()
          fn(v)
        }, ms)
      }
    },
    [fn, ms],
  )
}

/** Press-and-hold to confirm. No dialogs for destructive OS actions. */
export function HoldButton({
  children,
  onConfirm,
  holdMs = 1200,
  tone = "default",
  className,
}: {
  children: React.ReactNode
  onConfirm: () => void
  holdMs?: number
  tone?: "default" | "danger"
  className?: string
}) {
  const [holding, setHolding] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const start = () => {
    setHolding(true)
    timer.current = setTimeout(() => {
      setHolding(false)
      onConfirm()
    }, holdMs)
  }
  const cancel = () => {
    setHolding(false)
    if (timer.current) clearTimeout(timer.current)
  }
  useEffect(() => cancel, [])

  return (
    <button
      type="button"
      data-hold
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(e) => e.preventDefault()}
      className={cn(
        "relative flex h-16 touch-none select-none items-center justify-between gap-3 overflow-hidden rounded-[20px] border border-hairline bg-card px-5 text-left text-base font-medium transition-colors",
        tone === "danger" ? "text-destructive" : "text-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-0 left-0",
          tone === "danger" ? "bg-destructive/15" : "bg-season-soft",
        )}
        style={{
          width: holding ? "100%" : "0%",
          transition: holding ? `width ${holdMs}ms linear` : "width 200ms ease-out",
        }}
      />
      <span className="relative flex items-center gap-3">{children}</span>
      <span className="os-label relative">{holding ? "Keep holding" : "Hold"}</span>
    </button>
  )
}

/** Segmented control — equal-width text options, ink thumb. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="grid h-14 rounded-full bg-secondary p-1" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-full text-base font-medium transition-colors",
            o.value === value ? "bg-card text-foreground shadow-[0_0_0_1px_var(--hairline)]" : "text-muted-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** A pill switch: ink when on, with a round thumb (same as the phone). */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn(
        "relative h-8 w-[3.25rem] shrink-0 rounded-full transition-colors after:absolute after:-inset-3 after:content-['']",
        on ? "bg-foreground" : "bg-secondary shadow-[inset_0_0_0_1px_var(--border)]",
      )}
    >
      <span
        className={cn(
          "absolute left-1 top-1 size-6 rounded-full transition-transform duration-200",
          on ? "translate-x-5 bg-background" : "bg-muted-foreground/60",
        )}
      />
    </button>
  )
}
