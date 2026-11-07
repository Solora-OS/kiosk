"use client"

import { Luggage } from "lucide-react"
import { useAway } from "@/lib/away"
import { cn } from "@/lib/utils"

const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })

/** "Away: San Antonio · Dec 26 – Dec 30". */
export function AwayBanner({ note, className }: { note?: string; className?: string }) {
  const away = useAway()
  if (!away) return null
  return (
    <div className={cn("flex items-center gap-3 rounded-[20px] border border-hairline bg-card px-4 py-3", className)}>
      <Luggage className="size-5 shrink-0" aria-hidden />
      <p className="min-w-0 text-sm">
        <span className="font-semibold">Away{away.label ? `: ${away.label}` : ""}</span>
        <span className="text-muted-foreground"> · {fmt(away.from)} – {fmt(away.until)}</span>
        {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
      </p>
    </div>
  )
}
