"use client"

/**
 * widgets.tsx — the tiles a family can put on the wall's home screen. Each
 * entry in WIDGETS is self-contained: it reads household data from the store
 * and renders into whatever size the family chose. Adding a widget type means
 * adding one entry here.
 */

import { useEffect, useState, type ReactNode } from "react"
import {
  CalendarDays, Check, Clock3, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Flame, Gift,
  Images, ListChecks, Luggage, MapPin, StickyNote, Star, Sun, Timer, Utensils, Users,
  type LucideIcon,
} from "lucide-react"
import { api } from "@/lib/api"
import {
  type HomeWidget, type RewardsSummary, choreDone, choreDueOn, eventTimeLabel, expandEventsOn, memberBg, memberSoft, pausesWhileAway, toISODate,
} from "@/lib/data"
import { choreIcon } from "@/lib/chore-icons"
import { isAwayOn, useAway } from "@/lib/away"
import { useSummer } from "@/lib/summer"
import { useSeason } from "@/components/season-provider"
import { useStore } from "@/lib/store"
import { useClock24, usePhotoUrl } from "./widget-env"
import { CountdownTiles } from "@/components/ui/reusables/countdown-tiles"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { cn } from "@/lib/utils"

export type WidgetProps = { widget: HomeWidget; editing: boolean; onConfig: (config: Record<string, unknown>) => void }

export type WidgetDef = {
  type: string
  label: string
  description: string
  icon: LucideIcon
  defaultSize: HomeWidget["size"]
  /** The sizes this widget looks right at; the editor offers only these. */
  sizes: HomeWidget["size"][]
  render: (p: WidgetProps) => ReactNode
}

/** The frame every widget sits in. */
function Tile({ title, icon: Icon, children, className }: { title?: string; icon?: LucideIcon; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col gap-3 overflow-hidden rounded-lg bg-card p-5", className)}>
      {title ? (
        <p className="os-label flex items-center gap-1.5">
          {Icon ? <Icon className="size-3.5 text-season" /> : null}
          {title}
        </p>
      ) : null}
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  )
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

function useNow(everyMs: number) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(id)
  }, [everyMs])
  return now
}

// ----- Clock --------------------------------------------------------------------

/** Hours since midnight, the unit events use. */
const hoursOf = (d: Date) => d.getHours() + d.getMinutes() / 60

/** Timed, same-day events that have already finished. */
const isOver = (e: { allDay?: boolean; endDate?: string | null; end: number }, nowH: number) =>
  !e.allDay && !e.endDate && e.end <= nowH

function ClockWidget({ widget }: WidgetProps) {
  const now = useNow(10_000)
  const clock24 = useClock24()
  const { season } = useSeason()
  const { events } = useStore()
  const today = toISODate(now)
  // What's coming up beats a tagline: the next thing on today's calendar.
  const next = expandEventsOn(events, today).find((e) => !e.allDay && !e.endDate && e.start > hoursOf(now))
  const minsAway = next ? Math.round((next.start - hoursOf(now)) * 60) : 0
  const small = widget.size === "s"
  return (
    <Tile>
      <div className="flex h-full flex-col justify-end">
        <p className={cn("font-display leading-none tabular", small ? "text-5xl" : "text-7xl")}>
          {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: !clock24 })}
        </p>
        <p className={cn("mt-2", small ? "text-sm" : "text-lg")}>
          {now.toLocaleDateString(undefined, { weekday: "long", month: small ? "short" : "long", day: "numeric" })}
        </p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {next
            ? `${next.title} ${minsAway < 60 ? `in ${minsAway} min` : `at ${eventTimeLabel(next, today)}`}`
            : season.tagline}
        </p>
      </div>
    </Tile>
  )
}

// ----- Today / week -----------------------------------------------------------------

function TodayWidget({ widget }: WidgetProps) {
  const { events, getMember } = useStore()
  const now = useNow(60_000)
  const today = toISODate(now)
  const nowH = hoursOf(now)
  const all = expandEventsOn(events, today)
  // Finished events drop off as the day goes on.
  const list = all.filter((e) => !isOver(e, nowH))
  const done = all.length - list.length
  const max = widget.size === "l" || widget.size === "full" ? 10 : 5
  return (
    <Tile title="Today" icon={CalendarDays}>
      {list.length === 0 ? (
        <Empty>{done ? "That's everything for today." : "Nothing on the calendar today."}</Empty>
      ) : (
        <ul className="space-y-2">
          {list.slice(0, max).map((e) => (
            <li key={`${e.id}:${e.date}`} className="flex items-baseline gap-3">
              <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">
                {!e.allDay && !e.endDate && e.start <= nowH ? <span className="font-semibold text-season">Now</span> : eventTimeLabel(e, today)}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.title}</span>
              <span className="flex -space-x-1.5">
                {e.memberIds.slice(0, 3).map((id) => <MemberAvatar key={id} member={getMember(id)} size="sm" ring />)}
              </span>
            </li>
          ))}
          {list.length > max ? <li className="text-xs text-muted-foreground">+{list.length - max} more</li> : null}
        </ul>
      )}
    </Tile>
  )
}

function WeekWidget() {
  const { events } = useStore()
  const start = useNow(60_000)
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(d.getDate() + i)
    const iso = toISODate(d)
    return { iso, d, items: expandEventsOn(events, iso) }
  })
  return (
    <Tile title="The week ahead" icon={CalendarDays}>
      <ul className="grid grid-cols-7 gap-2">
        {days.map(({ iso, d, items }, i) => (
          <li key={iso} className={cn("min-w-0 rounded-md p-2", i === 0 && "bg-season/10")}>
            <p className="os-label">{d.toLocaleDateString(undefined, { weekday: "short" })}</p>
            <p className="font-display text-2xl leading-none tabular">{d.getDate()}</p>
            <div className="mt-1.5 space-y-0.5">
              {items.slice(0, 3).map((e) => <p key={`${e.id}:${e.date}`} className="truncate text-xs">{e.title}</p>)}
              {items.length > 3 ? <p className="text-xs text-muted-foreground">+{items.length - 3}</p> : null}
            </div>
          </li>
        ))}
      </ul>
    </Tile>
  )
}

// ----- Chores and points ----------------------------------------------------------------

function ChoresWidget() {
  const { chores, members, getMember, toggleChore } = useStore()
  const now = useNow(60_000)
  const today = toISODate(now)
  const paused = isAwayOn(useAway(), today)
  const summer = useSummer()
  const due = chores.filter((c) => choreDueOn(c, now, summer) && !(paused && pausesWhileAway(c)))
  // One column per person, plus "Anyone" for chores nobody's assigned (feeding the dog).
  const groups = [
    ...members
      .filter((m) => due.some((c) => c.memberId === m.id))
      .map((m) => ({ key: m.id, name: m.name, color: m.color, avatar: <MemberAvatar member={getMember(m.id)} size="sm" />, chores: due.filter((c) => c.memberId === m.id) })),
  ]
  const unassigned = due.filter((c) => !members.some((m) => m.id === c.memberId))
  if (unassigned.length) {
    groups.push({ key: "anyone", name: "Anyone", color: "teal", avatar: <Users className="size-5 text-muted-foreground" />, chores: unassigned })
  }
  return (
    <Tile title="Today's chores" icon={Check}>
      {due.length === 0 ? (
        <Empty>{paused ? "Chores are paused while you're away." : "No chores today."}</Empty>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(groups.length, 4)}, minmax(0, 1fr))` }}>
          {groups.map((m) => {
            const mine = m.chores
            const done = mine.filter((c) => choreDone(c, today)).length
            return (
              <div key={m.key} className="min-w-0 space-y-2">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  {m.avatar}
                  {m.name}
                  <span className="ml-auto text-xs font-normal text-muted-foreground tabular">{done}/{mine.length}</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  {mine.map((c) => {
                    const isDone = choreDone(c, today)
                    const Pic = choreIcon(c.icon ?? undefined)?.Icon ?? Check
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={isDone}
                        aria-label={`${c.title}${isDone ? ", done" : ""}`}
                        title={c.title}
                        onClick={() => toggleChore(c.id)}
                        className={cn(
                          "flex size-14 items-center justify-center rounded-lg transition-colors",
                          isDone ? cn(memberBg[m.color], "text-white") : memberSoft[m.color],
                        )}
                      >
                        <Pic className="size-6" />
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Tile>
  )
}

function PointsWidget() {
  const { members, chores } = useStore()
  const [summary, setSummary] = useState<RewardsSummary | null>(null)
  useEffect(() => {
    const load = () => { api.getRewards().then(setSummary).catch(() => {}) }
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [chores])
  const rows = members
    .map((m) => ({ m, p: summary?.points.find((x) => x.memberId === m.id) }))
    .filter(({ p }) => p && (p.balance > 0 || p.streak > 0))
  return (
    <Tile title="Points" icon={Star}>
      {rows.length === 0 ? (
        <Empty>Points show up here as chores get done.</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map(({ m, p }) => (
            <li key={m.id} className="flex items-center gap-2">
              <MemberAvatar member={m} size="sm" />
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              {p!.streak > 0 ? <span className="flex items-center gap-0.5 text-xs text-muted-foreground"><Flame className="size-3 text-season" />{p!.streak}</span> : null}
              <span className="font-semibold tabular">{p!.balance}</span>
            </li>
          ))}
        </ul>
      )}
      {summary && summary.redemptions.some((r) => r.status === "requested") ? (
        <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground"><Gift className="size-3" /> A reward is waiting for a parent</p>
      ) : null}
    </Tile>
  )
}

// ----- Countdowns, dinner, lists ----------------------------------------------------------

function CountdownWidget() {
  const { events } = useStore()
  return (
    <Tile title="Counting down" icon={Timer}>
      {events.some((e) => e.countdown) ? <CountdownTiles events={events} size="lg" /> : <Empty>Mark an event &ldquo;Count down to this&rdquo; to see it here.</Empty>}
    </Tile>
  )
}

function DinnerWidget() {
  const { meals, getMember } = useStore()
  const now = useNow(60_000)
  // After 8 PM tonight's dinner is history; show tomorrow's.
  const tomorrow = now.getHours() >= 20
  const day = new Date(now)
  if (tomorrow) day.setDate(day.getDate() + 1)
  const iso = toISODate(day)
  const weekday = day.toLocaleDateString("en-US", { weekday: "short" })
  const dinner =
    meals.find((m) => m.date === iso && /dinner/i.test(m.type)) ??
    meals.find((m) => !m.date && m.day === weekday && /dinner/i.test(m.type))
  return (
    <Tile title={tomorrow ? "Tomorrow's dinner" : "Tonight's dinner"} icon={Utensils}>
      {dinner ? (
        <div>
          <p className="font-display text-3xl leading-tight">{dinner.name}</p>
          {dinner.memberId ? <p className="mt-1 text-sm text-muted-foreground">Cooking: {getMember(dinner.memberId).name}</p> : null}
        </div>
      ) : (
        <Empty>No dinner planned yet.</Empty>
      )}
    </Tile>
  )
}

function ListWidget({ widget, editing, onConfig }: WidgetProps) {
  const { lists, toggleItem } = useStore()
  const chosen =
    lists.find((l) => l.id === widget.config?.listId) ?? lists.find((l) => /grocer|shopping/i.test(l.title)) ?? lists[0]
  const open = chosen?.items.filter((i) => !i.done) ?? []
  const max = widget.size === "l" || widget.size === "full" ? 14 : 7
  return (
    <Tile title={chosen?.title ?? "List"} icon={ListChecks}>
      {editing && lists.length > 1 ? (
        <select
          value={chosen?.id}
          onChange={(e) => onConfig({ listId: e.target.value })}
          className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        >
          {lists.map((l) => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      ) : null}
      {!chosen ? (
        <Empty>No lists yet.</Empty>
      ) : open.length === 0 ? (
        <Empty>All done.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {open.slice(0, max).map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => toggleItem(chosen.id, i.id)} className="flex w-full items-center gap-2.5 text-left">
                <span className={cn("size-5 shrink-0 rounded-full border-2 border-border")} />
                <span className="truncate">{i.label}</span>
              </button>
            </li>
          ))}
          {open.length > max ? <li className="text-xs text-muted-foreground">+{open.length - max} more</li> : null}
        </ul>
      )}
    </Tile>
  )
}

// ----- Weather -----------------------------------------------------------------

type Forecast = { temp: number; code: number; high: number; low: number; days: { date: string; code: number; high: number; low: number }[] }

/** WMO weather codes (Open-Meteo) to an icon and a word. */
function weatherLook(code: number): { icon: LucideIcon; label: string } {
  if (code === 0) return { icon: Sun, label: "Clear" }
  if (code <= 2) return { icon: CloudSun, label: "Partly cloudy" }
  if (code === 3) return { icon: Cloud, label: "Cloudy" }
  if (code <= 48) return { icon: CloudFog, label: "Fog" }
  if (code <= 57) return { icon: CloudDrizzle, label: "Drizzle" }
  if (code <= 67 || (code >= 80 && code <= 82)) return { icon: CloudRain, label: "Rain" }
  if (code <= 77 || code === 85 || code === 86) return { icon: CloudSnow, label: "Snow" }
  return { icon: CloudLightning, label: "Storms" }
}

/** Fahrenheit where people expect it; Celsius everywhere else. */
const useFahrenheit = () => /-(US|LR|MM)$/.test(navigator.language)

function useForecast(lat: number | undefined, lon: number | undefined): Forecast | null {
  const [data, setData] = useState<Forecast | null>(null)
  const f = useFahrenheit()
  useEffect(() => {
    if (lat == null || lon == null) return
    let alive = true
    const load = () => {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=4&timezone=auto${f ? "&temperature_unit=fahrenheit" : ""}`
      fetch(url)
        .then((r) => r.json())
        .then((j) => {
          if (!alive || !j?.current) return
          setData({
            temp: Math.round(j.current.temperature_2m),
            code: j.current.weather_code,
            high: Math.round(j.daily.temperature_2m_max[0]),
            low: Math.round(j.daily.temperature_2m_min[0]),
            days: (j.daily.time as string[]).slice(1).map((date, i) => ({
              date,
              code: j.daily.weather_code[i + 1],
              high: Math.round(j.daily.temperature_2m_max[i + 1]),
              low: Math.round(j.daily.temperature_2m_min[i + 1]),
            })),
          })
        })
        .catch(() => { /* offline: keep the last reading */ })
    }
    load()
    const id = setInterval(load, 30 * 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [lat, lon, f])
  return data
}

function WeatherWidget({ widget, editing, onConfig }: WidgetProps) {
  const lat = typeof widget.config?.lat === "number" ? widget.config.lat : undefined
  const lon = typeof widget.config?.lon === "number" ? widget.config.lon : undefined
  const place = typeof widget.config?.place === "string" ? widget.config.place : ""
  const forecast = useForecast(lat, lon)
  const [query, setQuery] = useState("")
  const [status, setStatus] = useState<string | null>(null)

  const findPlace = () => {
    const q = query.trim()
    if (!q) return
    setStatus("Looking…")
    fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1`)
      .then((r) => r.json())
      .then((j) => {
        const hit = j?.results?.[0]
        if (!hit) return setStatus(`Couldn't find “${q}”.`)
        setStatus(null)
        setQuery("")
        onConfig({ lat: hit.latitude, lon: hit.longitude, place: hit.name })
      })
      .catch(() => setStatus("No internet right now."))
  }

  if (editing || lat == null) {
    return (
      <Tile title="Weather" icon={CloudSun}>
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); findPlace() }} className="flex gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={place || "Your town"}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <button type="submit" className="rounded-md bg-secondary px-3 text-sm font-semibold">Set</button>
          </form>
        ) : (
          <Empty>Tap Edit to choose a town.</Empty>
        )}
        {status ? <p className="mt-2 text-xs text-muted-foreground">{status}</p> : place ? <p className="mt-2 text-xs text-muted-foreground">Showing {place}</p> : null}
      </Tile>
    )
  }

  if (!forecast) return <Tile title={place || "Weather"} icon={MapPin}><Empty>Checking the sky…</Empty></Tile>

  const now = weatherLook(forecast.code)
  const wide = widget.size !== "s"
  return (
    <Tile title={place} icon={MapPin}>
      <div className={cn("flex h-full", wide ? "items-end gap-6" : "flex-col justify-end")}>
        <div className="min-w-0">
          <now.icon className="size-9 text-season" strokeWidth={1.5} />
          <p className="mt-2 font-display text-5xl leading-none tabular">{forecast.temp}°</p>
          <p className="mt-1.5 truncate text-sm text-muted-foreground">
            {now.label} · {forecast.high}° / {forecast.low}°
          </p>
        </div>
        {wide ? (
          <ul className="ml-auto flex gap-4">
            {forecast.days.map((d) => {
              const look = weatherLook(d.code)
              return (
                <li key={d.date} className="flex flex-col items-center gap-1 text-sm">
                  <span className="os-label">{new Date(`${d.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short" })}</span>
                  <look.icon className="size-5 text-muted-foreground" strokeWidth={1.5} />
                  <span className="tabular">{d.high}°</span>
                  <span className="text-xs text-muted-foreground tabular">{d.low}°</span>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </Tile>
  )
}

// ----- Photos, note, away, family -----------------------------------------------------------

function PhotoWidget() {
  const { photos } = useStore()
  const [index, setIndex] = useState(0)
  useEffect(() => {
    if (photos.length < 2) return
    const id = setInterval(() => setIndex((i) => (i + 1) % photos.length), 20_000)
    return () => clearInterval(id)
  }, [photos.length])
  const photo = photos.length ? photos[index % photos.length] : null
  const src = usePhotoUrl(photo)
  if (!photo) return <Tile title="Photos" icon={Images}><Empty>Add photos from the Solora app.</Empty></Tile>
  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg bg-card">
      {src ? <img src={src} alt={photo.caption} className="absolute inset-0 size-full object-cover" /> : null}
      {photo.caption ? (
        <p className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-4 pb-3 pt-8 text-sm text-white">{photo.caption}</p>
      ) : null}
    </div>
  )
}

function NoteWidget({ widget, editing, onConfig }: WidgetProps) {
  const text = typeof widget.config?.text === "string" ? widget.config.text : ""
  return (
    <Tile title="Note" icon={StickyNote} className="bg-season/10">
      {editing ? (
        <textarea
          value={text}
          onChange={(e) => onConfig({ text: e.target.value.slice(0, 280) })}
          placeholder="Leave a note for the family"
          className="size-full resize-none rounded-md border border-border bg-background p-2 text-lg"
        />
      ) : (
        <p className="whitespace-pre-wrap font-display text-3xl leading-tight">{text || "Tap Customize to leave a note."}</p>
      )}
    </Tile>
  )
}

function AwayWidget() {
  const away = useAway()
  const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return (
    <Tile title="Away" icon={Luggage}>
      {away ? (
        <div>
          <p className="font-display text-3xl leading-tight">{away.label ?? "On a trip"}</p>
          <p className="mt-1 text-sm text-muted-foreground">{fmt(away.from)} – {fmt(away.until)} · chores paused</p>
        </div>
      ) : (
        <Empty>Everyone&apos;s home.</Empty>
      )}
    </Tile>
  )
}

function FamilyWidget() {
  const { members } = useStore()
  return (
    <Tile title="Family" icon={Users}>
      <div className="flex flex-wrap gap-3">
        {members.filter((m) => m.id !== "family").map((m) => (
          <div key={m.id} className="flex flex-col items-center gap-1">
            <MemberAvatar member={m} />
            <span className="text-xs">{m.name}</span>
          </div>
        ))}
      </div>
    </Tile>
  )
}

export const WIDGETS: WidgetDef[] = [
  { type: "clock", label: "Clock", description: "The time, and what's coming up next", icon: Clock3, defaultSize: "s", sizes: ["s", "m"], render: (p) => <ClockWidget {...p} /> },
  { type: "weather", label: "Weather", description: "Now and the next few days", icon: CloudSun, defaultSize: "s", sizes: ["s", "m"], render: (p) => <WeatherWidget {...p} /> },
  { type: "today", label: "Today", description: "What's left on the calendar today", icon: CalendarDays, defaultSize: "m", sizes: ["m", "l"], render: (p) => <TodayWidget {...p} /> },
  { type: "week", label: "The week ahead", description: "Seven days at a glance", icon: CalendarDays, defaultSize: "full", sizes: ["full"], render: () => <WeekWidget /> },
  { type: "chores", label: "Today's chores", description: "Picture chores to tap off, per person", icon: Check, defaultSize: "l", sizes: ["m", "l", "full"], render: () => <ChoresWidget /> },
  { type: "points", label: "Points", description: "Everyone's points and streaks", icon: Star, defaultSize: "s", sizes: ["s", "m"], render: () => <PointsWidget /> },
  { type: "countdown", label: "Countdowns", description: "Sleeps until the big days", icon: Timer, defaultSize: "m", sizes: ["m", "full"], render: () => <CountdownWidget /> },
  { type: "dinner", label: "Dinner", description: "Tonight's dinner; tomorrow's after 8 PM", icon: Utensils, defaultSize: "s", sizes: ["s", "m"], render: () => <DinnerWidget /> },
  { type: "list", label: "A list", description: "Groceries or any list; tap to tick off", icon: ListChecks, defaultSize: "m", sizes: ["s", "m", "l"], render: (p) => <ListWidget {...p} /> },
  { type: "photo", label: "Photo frame", description: "Family photos, changing every 20 seconds", icon: Images, defaultSize: "l", sizes: ["m", "l"], render: () => <PhotoWidget /> },
  { type: "note", label: "Note", description: "A message for everyone", icon: StickyNote, defaultSize: "s", sizes: ["s", "m"], render: (p) => <NoteWidget {...p} /> },
  { type: "away", label: "Away", description: "Where the family is when they're away", icon: Luggage, defaultSize: "s", sizes: ["s"], render: () => <AwayWidget /> },
  { type: "family", label: "Family", description: "Everyone in the household", icon: Users, defaultSize: "s", sizes: ["s", "m"], render: () => <FamilyWidget /> },
]

export const widgetDef = (type: string) => WIDGETS.find((w) => w.type === type) ?? null

/** A saved layout from before sizes were limited: snap each widget to a size it allows. */
export function fitSizes(widgets: HomeWidget[]): HomeWidget[] {
  return widgets.map((w) => {
    const def = widgetDef(w.type)
    return def && !def.sizes.includes(w.size) ? { ...w, size: def.defaultSize } : w
  })
}

export const DEFAULT_LAYOUT: HomeWidget[] = [
  { id: "w-clock", type: "clock", size: "s" },
  { id: "w-weather", type: "weather", size: "s" },
  { id: "w-today", type: "today", size: "m" },
  { id: "w-chores", type: "chores", size: "l" },
  { id: "w-photo", type: "photo", size: "l" },
  { id: "w-dinner", type: "dinner", size: "s" },
  { id: "w-points", type: "points", size: "s" },
  { id: "w-list", type: "list", size: "m" },
  { id: "w-week", type: "week", size: "full" },
]
