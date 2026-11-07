"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Calendar, Image, ListChecks, SlidersHorizontal, Sparkles, Sun, UtensilsCrossed, X } from "lucide-react"
import { useDisplayPrefs } from "@/lib/display-prefs"
import { cn } from "@/lib/utils"
import type { TabKey } from "@/lib/store"
import { requestAdd, useHeaderAdd } from "./header-add"

const tabs: { key: TabKey; label: string; icon: typeof Calendar }[] = [
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "chores", label: "Chores", icon: Sparkles },
  { key: "lists", label: "Lists", icon: ListChecks },
  { key: "meals", label: "Meals", icon: UtensilsCrossed },
  { key: "photos", label: "Photos", icon: Image },
]

/** What holding the sun offers, fanned out to its right (offsets from the sun's center, in rem). */
const quick: { tab: TabKey; label: string; icon: typeof Calendar; x: number; y: number }[] = [
  { tab: "calendar", label: "Event", icon: Calendar, x: 6.5, y: -1.5 },
  { tab: "chores", label: "Chore", icon: Sparkles, x: 9.5, y: 3.5 },
  { tab: "lists", label: "List item", icon: ListChecks, x: 9.5, y: 9 },
  { tab: "meals", label: "Meal", icon: UtensilsCrossed, x: 6.5, y: 14 },
]

const HOLD_MS = 400

/**
 * Primary rail. Home is the sun at the top, the same button that sits in the
 * phone's tab bar; hold it to add anything from anywhere. The tab you're on
 * turns ink and gets the season dot under its label, like the phone's tabs.
 * Rewards lives inside Chores, as on the phone.
 */
export function SideNav({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (tab: TabKey) => void
}) {
  // The family can hide tabs they don't use (Settings › Display); Settings always shows.
  const { hiddenTabs } = useDisplayPrefs()
  const shown = tabs.filter(({ key }) => !hiddenTabs.includes(key))
  const current: TabKey = active === "rewards" ? "chores" : active
  const add = useHeaderAdd()

  const sunRef = useRef<HTMLButtonElement>(null)
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const held = useRef(false)
  const [holding, setHolding] = useState(false)
  const [bloom, setBloom] = useState<{ x: number; y: number } | null>(null)

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current)
    holdTimer.current = null
    setHolding(false)
  }
  useEffect(() => clearHold, [])

  const pick = (tab: TabKey) => {
    setBloom(null)
    // Already there: that page's add is the one in the header.
    if (tab === current && add) return add.onClick()
    requestAdd()
    onChange(tab)
  }

  const item = (key: TabKey, label: string, Icon: typeof Calendar) => {
    const isActive = current === key
    return (
      <li key={key}>
        <button
          type="button"
          onClick={() => onChange(key)}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            "flex h-[4.4rem] w-full flex-col items-center justify-center gap-1.5 transition-colors",
            isActive ? "text-foreground" : "text-muted-foreground",
          )}
        >
          <Icon className="size-[1.5rem]" strokeWidth={isActive ? 2 : 1.6} />
          <span className={cn("text-[0.72rem]", isActive && "font-medium")}>{label}</span>
          <span className="tab-dot size-[5px] rounded-full bg-season-deep" />
        </button>
      </li>
    )
  }

  const home = current === "home"
  const rem = typeof window === "undefined" ? 16 : parseFloat(getComputedStyle(document.documentElement).fontSize) || 16

  return (
    <nav aria-label="Primary" className="flex h-full w-[5.5rem] shrink-0 flex-col items-center border-r border-hairline bg-background pb-2 pt-4">
      <button
        ref={sunRef}
        type="button"
        aria-label="Home. Press and hold to add"
        aria-current={home ? "page" : undefined}
        aria-haspopup="menu"
        data-held={holding || undefined}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={() => {
          held.current = false
          setHolding(true)
          holdTimer.current = setTimeout(() => {
            held.current = true
            setHolding(false)
            const r = sunRef.current?.getBoundingClientRect()
            if (r) setBloom({ x: r.left + r.width / 2, y: r.top + r.height / 2 })
          }, HOLD_MS)
        }}
        onPointerUp={clearHold}
        onPointerLeave={clearHold}
        onPointerCancel={clearHold}
        onClick={() => {
          if (held.current) return
          onChange("home")
        }}
        className={cn(
          "sun-press mb-3 flex size-[3.75rem] touch-none select-none items-center justify-center rounded-full",
          home
            ? "bg-season-deep text-season-ink shadow-[0_0_0_1px_var(--season-deep)]"
            : "bg-card text-season-deep shadow-[0_0_0_1px_var(--border)]",
        )}
      >
        <Sun className="size-[1.85rem]" strokeWidth={1.8} />
      </button>

      <ul className="flex w-full flex-1 flex-col gap-0.5">{shown.map(({ key, label, icon }) => item(key, label, icon))}</ul>

      <ul className="w-full">{item("settings", "Settings", SlidersHorizontal)}</ul>

      {bloom
        ? createPortal(
            <div className="fixed inset-0 z-50" role="presentation">
              <button
                type="button"
                aria-label="Close quick add"
                onClick={() => setBloom(null)}
                className="absolute inset-0 bg-black/45 animate-in fade-in duration-200"
              />
              <div role="menu" aria-label="Quick add">
                {quick.map(({ tab, label, icon: Icon, x, y }, i) => (
                  <div
                    key={label}
                    className="bloom-item absolute flex items-center gap-3"
                    style={
                      {
                        left: bloom.x + x * rem - 1.75 * rem,
                        top: bloom.y + y * rem - 1.75 * rem,
                        "--from-x": `${-x * rem}px`,
                        "--from-y": `${-y * rem}px`,
                        "--d": `${i * 30}ms`,
                      } as CSSProperties
                    }
                  >
                    <button
                      type="button"
                      role="menuitem"
                      aria-label={`Add ${label.toLowerCase()}`}
                      onClick={() => pick(tab)}
                      className="flex size-14 items-center justify-center rounded-full bg-card text-foreground dark:bg-secondary"
                    >
                      <Icon className="size-[1.4rem]" strokeWidth={1.8} />
                    </button>
                    <span className="text-sm font-medium text-white">{label}</span>
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label="Close quick add"
                onClick={() => setBloom(null)}
                className="absolute flex size-[3.75rem] items-center justify-center rounded-full bg-season-deep text-season-ink"
                style={{ left: bloom.x - 1.875 * rem, top: bloom.y - 1.875 * rem }}
              >
                <X className="size-[1.6rem] animate-in spin-in-90 fade-in duration-200" strokeWidth={2} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </nav>
  )
}
