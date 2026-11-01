"use client"

import { Calendar, CircleCheck, ListChecks, UtensilsCrossed, Image, Settings } from "lucide-react"
import { cn } from "@/lib/utils"

export type TabKey = "calendar" | "chores" | "lists" | "meals" | "photos" | "settings"

const tabs: { key: TabKey; label: string; icon: typeof Calendar }[] = [
  { key: "calendar", label: "Calendar", icon: Calendar },
  { key: "chores", label: "Chores", icon: CircleCheck },
  { key: "lists", label: "Lists", icon: ListChecks },
  { key: "meals", label: "Meals", icon: UtensilsCrossed },
  { key: "photos", label: "Photos", icon: Image },
  { key: "settings", label: "Settings", icon: Settings },
]

export function BottomNav({
  active,
  onChange,
}: {
  active: TabKey
  onChange: (tab: TabKey) => void
}) {
  return (
    <nav
      aria-label="Primary"
      className="sticky bottom-0 z-30 border-t border-border/60 bg-card"
    >
      <ul className="mx-auto flex max-w-2xl items-stretch justify-between px-2">
        {tabs.map(({ key, label, icon: Icon }) => {
          const isActive = active === key
          return (
            <li key={key} className="flex-1">
              <button
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex w-full flex-col items-center gap-1 rounded-2xl pt-2 pb-1.5 text-[0.7rem] font-medium transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span
                  className={cn(
                    "flex size-9 items-center justify-center rounded-2xl transition-all",
                    isActive ? "bg-primary/10 scale-105" : "bg-transparent",
                  )}
                >
                  <Icon className="size-5" strokeWidth={isActive ? 2.4 : 2} />
                </span>
                {label}
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
