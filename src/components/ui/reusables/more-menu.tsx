"use client"

import { useEffect, useRef, useState, type ComponentType } from "react"
import { createPortal } from "react-dom"
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"

export type MenuItem = {
  label: string
  icon?: ComponentType<{ className?: string }>
  destructive?: boolean
  onSelect: () => void
}

/**
 * A visible ⋯ that opens a short menu. On the wall nothing hides behind a
 * swipe or a long press: whatever you can do to a card, you can see the way in.
 */
export function MoreMenu({
  items,
  label = "More",
  className,
}: {
  items: (MenuItem | false | null | undefined)[]
  label?: string
  className?: string
}) {
  const shown = items.filter(Boolean) as MenuItem[]
  const btn = useRef<HTMLButtonElement>(null)
  const [at, setAt] = useState<{ top: number; right: number } | null>(null)

  useEffect(() => {
    if (!at) return
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setAt(null)
    document.addEventListener("keydown", esc)
    return () => document.removeEventListener("keydown", esc)
  }, [at])

  if (shown.length === 0) return null

  const open = () => {
    const r = btn.current?.getBoundingClientRect()
    if (!r) return
    setAt({ top: r.bottom + 6, right: window.innerWidth - r.right })
  }

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={!!at}
        onClick={(e) => {
          e.stopPropagation()
          if (at) setAt(null)
          else open()
        }}
        className={cn(
          "hit flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors",
          at && "bg-secondary text-foreground",
          className,
        )}
      >
        <MoreHorizontal className="size-[1.15rem]" />
      </button>
      {at
        ? createPortal(
            <div className="fixed inset-0 z-[60]" onClick={() => setAt(null)}>
              <div
                role="menu"
                onClick={(e) => e.stopPropagation()}
                className="pop-in absolute min-w-52 origin-top-right overflow-hidden rounded-[18px] border border-hairline bg-popover p-1.5 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.4)]"
                style={{ top: Math.min(at.top, window.innerHeight - 64 * shown.length - 16), right: at.right }}
              >
                {shown.map(({ label: l, icon: Icon, destructive, onSelect }) => (
                  <button
                    key={l}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAt(null)
                      onSelect()
                    }}
                    className={cn(
                      "flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[0.95rem] active:bg-secondary",
                      destructive ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {Icon ? <Icon className="size-4 shrink-0" /> : null}
                    {l}
                  </button>
                ))}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  )
}

/** The usual pair: Edit, then Delete in red. */
export function editDelete(onEdit?: () => void, onDelete?: () => void, editLabel = "Edit"): (MenuItem | false)[] {
  return [
    !!onEdit && { label: editLabel, icon: Pencil, onSelect: onEdit },
    !!onDelete && { label: "Delete", icon: Trash2, destructive: true, onSelect: onDelete },
  ]
}
