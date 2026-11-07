"use client"

import { useEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { Check, ChevronRight, X } from "lucide-react"
import { useSeason } from "@/components/season-provider"
import { seasonForDate } from "@/lib/seasons"
import { cn } from "@/lib/utils"

/**
 * Compact pickers: one row that says what's chosen, and a small pop-up list to
 * change it. Long option lists (seasons, holidays) never sit open on a page.
 * Kept identical in mobile/ and kiosk/.
 */

/** A settings row: label on the left, current value and a chevron on the right. */
export function PickerRow({
  label,
  value,
  swatch,
  onClick,
  disabled,
}: {
  label: string
  value: string
  swatch?: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex min-h-14 w-full items-center gap-3 rounded-[16px] bg-secondary/60 px-4 py-3 text-left transition-colors hover:bg-secondary active:bg-secondary disabled:opacity-60"
    >
      <span className="flex-1 text-[15px] font-medium">{label}</span>
      {swatch ? <span className="size-3.5 shrink-0 rounded-full" style={{ background: swatch }} aria-hidden /> : null}
      <span className="max-w-[55%] truncate text-[15px] text-muted-foreground">{value}</span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  )
}

/** A small centered list dialog, layered above everything (including the Control panel). */
export function PickerDialog({
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
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      // Close just this list, not the Control panel underneath.
      e.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-end justify-center p-4 sm:items-center">
      <div className="absolute inset-0 bg-black/40 animate-in fade-in duration-200" onClick={onClose} aria-hidden />
      <div
        role="dialog"
        aria-label={title}
        className="relative flex max-h-[75dvh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-hairline bg-popover shadow-[0_24px_60px_-20px_oklch(0_0_0/0.6)] animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200"
      >
        <div className="flex items-center justify-between border-b border-hairline py-1.5 pl-4 pr-1.5">
          <p className="text-[15px] font-semibold">{title}</p>
          <button type="button" onClick={onClose} aria-label="Close" className="flex size-10 items-center justify-center rounded-[12px] text-muted-foreground hover:bg-secondary">
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto overscroll-contain py-1">{children}</div>
        {footer ? <div className="border-t border-hairline p-3">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}

/** One choice in a PickerDialog list. */
export function PickerOption({
  label,
  detail,
  swatch,
  selected,
  onClick,
  trailing,
  disabled,
}: {
  label: string
  detail?: string
  swatch?: string
  selected: boolean
  onClick: () => void
  trailing?: ReactNode
  disabled?: boolean
}) {
  return (
    <div className="flex items-center">
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={selected}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-12 flex-1 items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-secondary active:bg-secondary disabled:cursor-default disabled:hover:bg-transparent"
      >
        {swatch ? <span className="size-3.5 shrink-0 rounded-full" style={{ background: swatch }} aria-hidden /> : null}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px]">{label}</span>
          {detail ? <span className="block truncate text-xs text-muted-foreground">{detail}</span> : null}
        </span>
        <Check className={cn("size-4 shrink-0", selected ? "text-foreground" : "text-transparent")} strokeWidth={2.5} />
      </button>
      {trailing}
    </div>
  )
}

/**
 * The season this screen wears: a row showing the current pick, a pop-up list
 * of Automatic plus every look. `footer` holds extras like importing a theme.
 */
export function SeasonPicker({
  open,
  onOpenChange,
  footer,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  footer?: ReactNode
  onRemove?: (id: string) => void
}) {
  const { mode, season, seasons, holidays, setMode } = useSeason()
  const auto = seasons.find((s) => s.id === seasonForDate(new Date(), holidays))
  return (
    <>
      <PickerRow
        label="Season"
        value={mode === "auto" ? `Automatic · ${auto?.name ?? season.name}` : season.name}
        swatch={season.accent.light}
        onClick={() => onOpenChange(true)}
      />
      <PickerDialog open={open} onClose={() => onOpenChange(false)} title="Season" footer={footer}>
        <PickerOption
          label="Automatic"
          detail={`Follows the calendar and your holidays · now ${auto?.name ?? season.name}`}
          selected={mode === "auto"}
          onClick={() => { setMode("auto"); onOpenChange(false) }}
        />
        <div className="mx-4 my-1 h-px bg-hairline" />
        {seasons.map((s) => (
          <PickerOption
            key={s.id}
            label={s.name}
            swatch={s.accent.light}
            selected={mode === s.id}
            onClick={() => { setMode(s.id); onOpenChange(false) }}
            trailing={
              s.imported && onRemove ? (
                <button
                  type="button"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => onRemove(s.id)}
                  className="mr-2 flex size-10 items-center justify-center rounded-[12px] text-muted-foreground hover:text-destructive"
                >
                  <X className="size-4" />
                </button>
              ) : undefined
            }
          />
        ))}
      </PickerDialog>
    </>
  )
}
