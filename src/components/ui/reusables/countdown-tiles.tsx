"use client"

import { type CalendarEvent, countdownLabel, upcomingCountdowns } from "@/lib/data"
import { homeTodayISO, useHomeTimeZone } from "@/lib/home-time"
import { PartyPopper } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * "9 sleeps until Christmas" — big numbers for events marked "Count down to
 * this", soonest first. Kept identical in mobile/ and kiosk/.
 */
export function CountdownTiles({ events, size = "md", className }: { events: CalendarEvent[]; size?: "md" | "lg"; className?: string }) {
  useHomeTimeZone()
  // Count down on the home date, so family abroad don't see "today" a day early.
  const tiles = upcomingCountdowns(events, homeTodayISO())
  if (tiles.length === 0) return null
  return (
    <div className={cn("grid gap-2", tiles.length > 1 && "grid-cols-2", tiles.length > 2 && "sm:grid-cols-3", className)}>
      {tiles.map(({ event, days }) => (
        <div
          key={event.id}
          aria-label={countdownLabel(event.title, days)}
          className={cn("flex items-baseline gap-3 rounded-lg bg-season/10 px-4", size === "lg" ? "py-4" : "py-3")}
        >
          <span className={cn("font-display leading-none text-season tabular", size === "lg" ? "text-6xl" : "text-4xl")}>
            {days === 0 ? <PartyPopper className={size === "lg" ? "size-12" : "size-8"} aria-hidden /> : days}
          </span>
          <span className="min-w-0">
            <span className="os-label block">{days === 0 ? "Today" : days === 1 ? "sleep until" : "sleeps until"}</span>
            <span className={cn("block truncate font-medium", size === "lg" ? "text-xl" : "text-base")}>{event.title}</span>
          </span>
        </div>
      ))}
    </div>
  )
}
