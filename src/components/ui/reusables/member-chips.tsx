"use client"

import { cn } from "@/lib/utils"
import { memberBg } from "@/lib/data"
import { useStore } from "@/lib/store"

/**
 * Family filter. Reads like a row of tabs: a name with its color dot, the
 * active one underlined in ink. Color stays in the dots — never the fills.
 */
export function MemberChips() {
  const { members, activeMember, setActiveMember } = useStore()

  const item = (active: boolean) =>
    cn(
      "relative flex h-11 shrink-0 items-center gap-2 text-[0.95rem] transition-colors",
      active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
    )
  const underline = (active: boolean) =>
    cn(
      "absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-foreground transition-opacity",
      active ? "opacity-100" : "opacity-0",
    )

  return (
    <div className="relative z-20 border-b border-hairline px-8">
      <div className="no-scrollbar flex gap-7 overflow-x-auto">
        <button type="button" onClick={() => setActiveMember(null)} className={item(activeMember === null)}>
          Everyone
          <span className={underline(activeMember === null)} />
        </button>
        {members
          .filter((m) => m.id !== "family")
          .map((m) => (
            <button key={m.id} type="button" onClick={() => setActiveMember(m.id)} className={item(activeMember === m.id)}>
              <span className={cn("size-2 rounded-full", memberBg[m.color])} />
              {m.name}
              <span className={underline(activeMember === m.id)} />
            </button>
          ))}
      </div>
    </div>
  )
}
