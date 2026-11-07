"use client"

/**
 * activity-sheet.tsx — Settings › Activity.
 *
 *   Family       who did what in the household, from the hub's history
 *                (kiosk/server/src/routes/activity-logs.ts), including what
 *                Solora did and why.
 *   This device  this display's own system log (lib/hub.ts): updates,
 *                restarts, connection problems.
 *
 * Kept in step with mobile/src/app/settings/activity-sheet.tsx; the wall
 * version has bigger touch targets for use at arm's length.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react"
import {
  CalendarDays, CircleCheck, CircleCheckBig, Eraser, History, Info, LifeBuoy, ListTodo, Monitor,
  TriangleAlert, Users, UtensilsCrossed, type LucideIcon,
} from "lucide-react"
import { BottomSheet } from "@/components/ui/reusables/bottom-sheet"
import { WaveLoader } from "@/components/os/loading"
import { api, type ActivityCategory, type ActivityEntry } from "@/lib/api"
import { memberBg } from "@/lib/data"
import { clearLogs, getLogs, subscribeLogs, type HubLogEntry, type HubLogLevel } from "@/lib/hub"
import { useStore } from "@/lib/store"
import { cn } from "@/lib/utils"

const PAGE = 40

const CATEGORIES: Array<{ id: ActivityCategory | "all"; label: string; icon: LucideIcon }> = [
  { id: "all", label: "All", icon: History },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "chores", label: "Chores", icon: CircleCheckBig },
  { id: "lists", label: "Lists", icon: ListTodo },
  { id: "meals", label: "Meals", icon: UtensilsCrossed },
  { id: "family", label: "Family", icon: Users },
  { id: "hub", label: "Hub & Solora", icon: Monitor },
]
const CATEGORY = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<ActivityCategory | "all", (typeof CATEGORIES)[number]>

// ── Shared bits ───────────────────────────────────────────────────────────────

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((start(new Date()) - start(d)) / 86_400_000)
  if (diff === 0) return "Today"
  if (diff === 1) return "Yesterday"
  if (diff < 7) return d.toLocaleDateString(undefined, { weekday: "long" })
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" })
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

/** Items grouped under day headings, newest day first. */
function byDay<T>(items: T[], at: (t: T) => string): Array<{ day: string; items: T[] }> {
  const groups: Array<{ day: string; items: T[] }> = []
  for (const it of items) {
    const day = dayLabel(at(it))
    const last = groups[groups.length - 1]
    if (last?.day === day) last.items.push(it)
    else groups.push({ day, items: [it] })
  }
  return groups
}

function DayHeading({ children }: { children: ReactNode }) {
  return <h3 className="sticky top-0 z-10 bg-card/95 px-1 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur first:pt-1">{children}</h3>
}

function EmptyState({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground"><Icon className="size-6" /></span>
      <p className="text-sm font-semibold">{title}</p>
      {children ? <p className="max-w-xs text-sm text-muted-foreground">{children}</p> : null}
    </div>
  )
}

// ── Sheet ─────────────────────────────────────────────────────────────────────

export function ActivitySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<"family" | "device">("family")
  return (
    <BottomSheet open={open} onClose={onClose} title="Activity">
      <div role="tablist" aria-label="Activity" className="grid grid-cols-2 gap-1 rounded-[16px] bg-secondary p-1">
        {([["family", "Family"], ["device", "This device"]] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
            className={cn("min-h-12 rounded-[12px] text-sm font-semibold transition-colors",
              tab === id ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground")}>
            {label}
          </button>
        ))}
      </div>
      <div className="max-h-[62vh] overflow-y-auto overscroll-contain pt-1">
        {tab === "family" ? <FamilyActivity open={open} /> : <DeviceLog />}
      </div>
    </BottomSheet>
  )
}

// ── Family ────────────────────────────────────────────────────────────────────

function FamilyActivity({ open }: { open: boolean }) {
  const { members } = useStore()
  const [category, setCategory] = useState<ActivityCategory | "all">("all")
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (older?: string) => {
    setBusy(true)
    setError(null)
    try {
      const page = await api.getActivity({ category: category === "all" ? undefined : category, before: older, limit: PAGE })
      setEntries((prev) => (older && prev ? [...prev, ...page] : page))
      setMore(page.length === PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the family's activity.")
    }
    setBusy(false)
  }, [category])

  useEffect(() => {
    if (open) { setEntries(null); void load() }
  }, [open, load])

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members])
  const groups = useMemo(() => byDay(entries ?? [], (e) => e.createdAt), [entries])

  return (
    <div className="flex flex-col gap-1">
      <div role="group" aria-label="Show" className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 pt-3 [scrollbar-width:none]">
        {CATEGORIES.map((c) => (
          <button key={c.id} type="button" aria-pressed={category === c.id} onClick={() => setCategory(c.id)}
            className={cn("flex min-h-12 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-semibold transition-colors",
              category === c.id ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
            <c.icon className="size-4" />{c.label}
          </button>
        ))}
      </div>

      {error ? (
        <EmptyState icon={TriangleAlert} title="Couldn't load activity">{error}</EmptyState>
      ) : entries === null ? (
        <div className="flex justify-center py-12"><WaveLoader size={22} /></div>
      ) : entries.length === 0 ? (
        <EmptyState icon={History} title="Nothing here yet">
          {category === "all" ? "When someone adds an event, finishes a chore or plans a meal, it shows up here." : `No ${CATEGORY[category].label.toLowerCase()} activity yet.`}
        </EmptyState>
      ) : (
        <>
          {groups.map((g) => (
            <section key={g.day}>
              <DayHeading>{g.day}</DayHeading>
              <ul className="divide-y divide-hairline overflow-hidden rounded-[20px] bg-background">
                {g.items.map((e) => <ActivityRow key={e.id} entry={e} member={e.actorId ? memberById.get(e.actorId) : undefined} />)}
              </ul>
            </section>
          ))}
          {more ? (
            <button type="button" disabled={busy} onClick={() => void load(entries[entries.length - 1]?.cursor)}
              className="mt-3 flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-secondary text-sm font-semibold disabled:opacity-60">
              {busy ? <WaveLoader size={16} /> : null}Show older
            </button>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">That's everything.</p>
          )}
        </>
      )}
    </div>
  )
}

function ActivityRow({ entry: e, member }: { entry: ActivityEntry; member?: { name: string; initial: string; color: string } }) {
  const Cat = CATEGORY[e.category]?.icon ?? History
  // Who did it starts the sentence; set in bold so rows scan by person.
  const lead = e.lead && e.summary.startsWith(e.lead) ? e.lead : ""
  return (
    <li className="flex gap-3 px-3.5 py-3">
      {e.bySolora ? (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-secondary text-foreground"><LifeBuoy className="size-[18px]" /></span>
      ) : member ? (
        <span aria-hidden="true" className={cn("flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white", memberBg[member.color as keyof typeof memberBg])}>
          {member.initial || member.name.charAt(0)}
        </span>
      ) : (
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          {e.actorName === "Wall display" ? <Monitor className="size-[18px]" /> : <Cat className="size-[18px]" />}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[15px] leading-snug">
          {lead ? <><span className="font-semibold">{lead}</span>{e.summary.slice(lead.length)}</> : e.summary}
        </p>
        {e.reason ? <p className="mt-1 text-sm text-muted-foreground">“{e.reason}”</p> : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{clock(e.createdAt)}</span>
          <span aria-hidden="true">·</span>
          <span className="flex items-center gap-1"><Cat className="size-3.5" />{CATEGORY[e.category]?.label ?? "Hub"}</span>
          {e.bySolora ? <span className="rounded-full bg-secondary px-2 py-0.5 font-semibold text-foreground">Solora</span> : null}
        </p>
      </div>
    </li>
  )
}

// ── This device ───────────────────────────────────────────────────────────────

const LEVEL: Record<HubLogLevel, { icon: LucideIcon; className: string; label: string }> = {
  info: { icon: Info, className: "text-member-blue", label: "Info" },
  success: { icon: CircleCheck, className: "text-member-green", label: "Done" },
  warning: { icon: TriangleAlert, className: "text-member-amber", label: "Warning" },
  error: { icon: TriangleAlert, className: "text-destructive", label: "Problem" },
}

function DeviceLog() {
  const logs = useSyncExternalStore(subscribeLogs, getLogs, getLogs)
  const [problemsOnly, setProblemsOnly] = useState(false)
  const shown = problemsOnly ? logs.filter((l) => l.level === "warning" || l.level === "error") : logs
  const problems = logs.filter((l) => l.level === "warning" || l.level === "error").length
  const groups = byDay(shown, (l: HubLogEntry) => l.time)

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 pt-3">
        <label className="flex min-h-12 items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} className="size-5 accent-primary" />
          Problems only{problems ? <span className="rounded-full bg-destructive/12 px-2 text-xs font-semibold text-destructive">{problems}</span> : null}
        </label>
        <button type="button" onClick={() => clearLogs()} disabled={logs.length === 0}
          className="flex min-h-12 items-center gap-1.5 rounded-full bg-secondary px-3.5 text-sm font-semibold disabled:opacity-40">
          <Eraser className="size-4" />Clear
        </button>
      </div>
      <p className="px-1 text-xs text-muted-foreground">Updates, restarts and connection messages from this display. Warnings reach Solora Support only if your family allows it.</p>

      {shown.length === 0 ? (
        <EmptyState icon={problemsOnly ? CircleCheck : Info} title={problemsOnly ? "No problems" : "Nothing logged yet"}>
          {problemsOnly ? "Everything on this display went through." : "Messages appear as this display connects and updates."}
        </EmptyState>
      ) : groups.map((g) => (
        <section key={g.day}>
          <DayHeading>{g.day}</DayHeading>
          <ul className="divide-y divide-hairline overflow-hidden rounded-[20px] bg-background">
            {g.items.map((l) => {
              const lv = LEVEL[l.level]
              return (
                <li key={l.id} className="flex gap-3 px-3.5 py-3">
                  <lv.icon className={cn("mt-0.5 size-[18px] shrink-0", lv.className)} aria-label={lv.label} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug">{l.message}</p>
                    <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{clock(l.time)}</span>
                      <span className="rounded bg-secondary px-1.5 py-0.5 font-medium">{l.source}</span>
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
