"use client"

import { type CalendarEvent, countdownLabel, upcomingCountdowns } from "@/lib/data"
import { homeTodayISO, useHomeTimeZone } from "@/lib/home-time"
import { PartyPopper } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * "9 sleeps until Christmas" — big numbers for events marked "Count down to
 * this", soonest first: one card split by hairlines, like the phone's strip.
 */
export function CountdownTiles({ events, size = "md", bare = false, className }: { events: CalendarEvent[]; size?: "md" | "lg"; /** Inside another card: no card of its own. */ bare?: boolean; className?: string }) {
  useHomeTimeZone()
  // Count down on the home date, so family abroad don't see "today" a day early.
  const tiles = upcomingCountdowns(events, homeTodayISO())
  if (tiles.length === 0) return null
  return (
    <div className={cn("flex divide-x divide-hairline", !bare && "rounded-[20px] border border-hairline bg-card", className)}>
      {tiles.map(({ event, days }) => (
        <div
          key={event.id}
          aria-label={countdownLabel(event.title, days)}
          className={cn("flex min-w-0 flex-1 flex-col justify-end px-4", size === "lg" ? "py-4" : "py-3")}
        >
          <span className={cn("font-display leading-none tabular", size === "lg" ? "text-[3.25rem]" : "text-[2.4rem]")}>
            {days === 0 ? <PartyPopper className={size === "lg" ? "size-11" : "size-8"} aria-hidden /> : days}
          </span>
          <span className="mt-1.5 truncate text-xs text-muted-foreground">
            {days === 0 ? `${event.title} is today` : `${days === 1 ? "sleep" : "sleeps"} to ${event.title}`}
          </span>
        </div>
      ))}
    </div>
  )
}
