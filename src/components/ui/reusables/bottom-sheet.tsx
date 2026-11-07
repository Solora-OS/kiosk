"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

// Global counter so multiple sheets (or rapid open/close) don't fight over
// body overflow. We only lock when count > 0 and unlock when it hits 0.
let _openCount = 0
function lockScroll() {
  _openCount++
  document.body.style.overflow = "hidden"
}
function unlockScroll() {
  _openCount = Math.max(0, _openCount - 1)
  if (_openCount === 0) document.body.style.overflow = ""
}

export function BottomSheet({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
}) {
  const [visible, setVisible] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Portal mount guard
  useEffect(() => { setMounted(true) }, [])

  // Drive open/close animation
  useEffect(() => {
    if (open) {
      setVisible(true)
      // Tiny delay so the element is in the DOM before we trigger the CSS transition
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimating(true)))
    } else {
      setAnimating(false)
      closeTimerRef.current = setTimeout(() => setVisible(false), 300)
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [open])

  const requestClose = useCallback(() => {
    const active = document.activeElement as HTMLElement | null
    if (active && typeof active.blur === "function") active.blur()
    onClose()
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && requestClose()
    document.addEventListener("keydown", onKey)
    lockScroll()
    return () => {
      document.removeEventListener("keydown", onKey)
      unlockScroll()
    }
  }, [open, requestClose])

  if (!mounted || !visible) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-end">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/35"
        style={{
          opacity: animating ? 1 : 0,
          transition: "opacity 300ms cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        onClick={requestClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 flex h-full w-full max-w-[30rem] flex-col border-l border-hairline bg-background shadow-[-30px_0_60px_-30px_rgb(0_0_0/0.45)]"
        style={{
          transform: animating ? "translateX(0)" : "translateX(100%)",
          transition: "transform 320ms cubic-bezier(0.25, 1, 0.5, 1)",
        }}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between px-7 pb-4 pt-6">
          <h2 className="font-display text-[2rem] leading-none">{title}</h2>
          <button
            type="button"
            onClick={requestClose}
            aria-label="Close"
            className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden border-t border-hairline px-7 py-6">
          <div className="space-y-5">{children}</div>
        </div>

        {/* Footer */}
        {footer ? (
          <div className="shrink-0 border-t border-hairline px-7 py-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="os-label mb-2 block">
        {label}
      </span>
      {children}
    </label>
  )
}

/** Soft box field — matches .os-field on system screens, sized for sheets. */
export const inputClass =
  "w-full min-h-[3.25rem] rounded-[14px] border border-hairline bg-card px-4 py-3 text-[1.05rem] outline-none transition-colors focus:border-foreground"

/** A row of tappable choices, used in sheets instead of a native select (no popups on a wall). */
export function ChoiceChips<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode; lead?: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={String(o.value)}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex h-11 items-center gap-2 rounded-full border text-[0.95rem] font-medium transition-colors",
              o.lead ? "pl-1.5 pr-4" : "px-4",
              on ? "border-transparent bg-foreground text-background" : "border-hairline bg-card text-foreground",
            )}
          >
            {o.lead}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
