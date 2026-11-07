"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Delete",
  onConfirm,
  onCancel,
  secondaryLabel,
  onSecondary,
}: {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  /** Optional second destructive choice, e.g. "This one" beside "All events". */
  secondaryLabel?: string
  onSecondary?: () => void
}) {
  const [visible, setVisible] = useState(false)
  const [animating, setAnimating] = useState(false)
  const [mounted, setMounted] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    if (open) {
      setVisible(true)
      requestAnimationFrame(() => requestAnimationFrame(() => setAnimating(true)))
    } else {
      setAnimating(false)
      closeTimerRef.current = setTimeout(() => setVisible(false), 280)
    }
    return () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel()
    document.addEventListener("keydown", onKey)
    return () => document.removeEventListener("keydown", onKey)
  }, [open, onCancel])

  if (!mounted || !visible) return null

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center px-6"
      style={{
        opacity: animating ? 1 : 0,
        transition: "opacity 280ms cubic-bezier(0.4, 0, 0.2, 1)",
      }}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/35"
        onClick={onCancel}
        aria-hidden
      />

      {/* Card */}
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-[20px] border border-border bg-popover"
        style={{
          transform: animating ? "scale(1) translateY(0)" : "scale(0.95) translateY(8px)",
          transition: "transform 280ms cubic-bezier(0.34, 1.56, 0.64, 1)",
        }}
      >
        <div className="px-6 pb-5 pt-7">
          <h2 className="font-display text-3xl leading-tight text-foreground">{title}</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>
        </div>

        <div className="flex flex-row-reverse gap-2 border-t border-hairline px-6 py-4">
          <button
            type="button"
            onClick={onConfirm}
            className="h-12 flex-1 rounded-full bg-destructive text-sm font-medium text-white transition-opacity hover:opacity-90 active:opacity-80"
          >
            {confirmLabel}
          </button>
          {onSecondary ? (
            <button
              type="button"
              onClick={onSecondary}
              className="h-12 flex-1 rounded-[12px] border border-destructive/40 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              {secondaryLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            className="h-12 flex-1 rounded-[12px] text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
