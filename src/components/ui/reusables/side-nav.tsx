"use client"

import { useEffect, useState } from "react"
import { Calendar, CircleCheck, Gift, ListChecks, UtensilsCrossed, Image, Settings, SlidersHorizontal } from "lucide-react"
import { useDisplayPrefs } from "@/lib/display-prefs"
import { cn } from "@/lib/utils"
import type { TabKey } from "@/lib/store"
import { openControlCenter } from "@/components/os/control-center"

const tabs: { key: TabKey; label: string; icon: typeof Calendar }[] = [
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "chores", label: "Chores", icon: CircleCheck },
  { key: "rewards", label: "Rewards", icon: Gift },
  { key: "lists", label: "Lists", icon: ListChecks },
  { key: "meals", label: "Meals", icon: UtensilsCrossed },
  { key: "photos", label: "Photos", icon: Image },
  { key: "settings", label: "Settings", icon: Settings },
]

/** Today as a tear-off calendar leaf: weekday, big numeral, month. It's also the way home. */
function DateLeaf({ active, onClick }: { active: boolean; onClick: () => void }) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Home"
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative flex flex-col items-center pb-5 pt-6 transition-colors active:scale-95",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full bg-season transition-all duration-300",
          active ? "h-12 opacity-100" : "h-0 opacity-0",
        )}
      />
      <span className="os-label">{now.toLocaleDateString(undefined, { weekday: "short" })}</span>
      <span className="mt-1 font-display text-[3.25rem] leading-none tabular">{now.getDate()}</span>
      <span className="os-label mt-1">{now.toLocaleDateString(undefined, { month: "short" })}</span>
    </button>
  )
}

/**
 * Primary rail. Narrow, quiet, and anchored by today's date. The active
 * section is marked by a short season-colored bar on the rail edge — no
 * filled pills, no oversized icons.
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
  const shown = tabs.filter(({ key }) => key === "settings" || !hiddenTabs.includes(key))
  return (
    <nav aria-label="Primary" className="flex h-full w-24 shrink-0 flex-col border-r border-hairline bg-background">
      <DateLeaf active={active === "home"} onClick={() => onChange("home")} />
      <div className="mx-6 h-px bg-hairline" />

      <ul className="flex flex-1 flex-col gap-1 pt-4">
        {shown.map(({ key, label, icon: Icon }) => {
          const isActive = active === key
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "relative flex h-[4.25rem] w-full flex-col items-center justify-center gap-2 transition-colors",
                  isActive ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "absolute left-0 top-1/2 w-[3px] -translate-y-1/2 rounded-r-full bg-season transition-all duration-300",
                    isActive ? "h-8 opacity-100" : "h-0 opacity-0",
                  )}
                />
                <Icon className="size-[1.4rem]" strokeWidth={isActive ? 1.9 : 1.5} />
                <span className={cn("font-mono text-[0.7rem] uppercase tracking-[0.08em]", isActive && "font-medium")}>
                  {label}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <button
        type="button"
        onClick={openControlCenter}
        className="flex h-20 flex-col items-center justify-center gap-2 border-t border-hairline text-muted-foreground/70 transition-colors hover:text-foreground"
      >
        <SlidersHorizontal className="size-5" strokeWidth={1.5} />
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.08em]">Control</span>
      </button>
    </nav>
  )
}
