"use client"

import { useSeason } from "@/components/season-provider"
import { SeasonCorner, SeasonMark } from "@/components/season/ornaments"
import { Wordmark } from "@/components/os/wordmark"
import { OrbitMark } from "@/components/os/orbit"

/**
 * Boot screen.
 *
 * Shown the instant the appliance powers on while we load local device state.
 * A wordmark set large in the lower-left, the season's line beneath it, and a
 * single hairline sweeping along the bottom edge. Nothing of Linux, ever.
 */
export function SplashScreen({ message = "Starting up" }: { message?: string }) {
  const { season } = useSeason()
  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })

  return (
    <main className="relative flex h-dvh flex-col justify-between overflow-hidden bg-background px-12 pb-0 pt-10 text-foreground">
      <SeasonCorner className="size-[30rem]" />

      <div className="relative flex items-center justify-between os-label">
        <span>{date}</span>
      </div>

      <div className="relative pb-14">
        <OrbitMark animate className="mb-8 size-28" />
        <Wordmark className="rise-in block text-[8.5rem] lg:text-[11rem]" />
        <p className="rise-in mt-4 flex items-center gap-3 font-display text-3xl italic text-muted-foreground [animation-delay:120ms]">
          <SeasonMark className="text-2xl not-italic" />
          {season.tagline}
        </p>
      </div>

      <div className="relative -mx-12">
        <div className="flex items-center justify-between px-12 pb-4 os-label">
          <span>{message}</span>
          <span className="tabular">Solora OS</span>
        </div>
        <div className="boot-line h-[2px] bg-hairline" />
      </div>
    </main>
  )
}
