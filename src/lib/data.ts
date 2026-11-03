/** The six theme colors; they shift with light and dark mode. */
export const presetColors = ["coral", "amber", "teal", "blue", "pink", "green"] as const
export type PresetColor = (typeof presetColors)[number]
/** A theme preset, or a custom color picked by hand as "#rrggbb". */
export type MemberColor = PresetColor | `#${string}`

export function isPresetColor(c: string | undefined): c is PresetColor {
  return !!c && (presetColors as readonly string[]).includes(c)
}

/** A CSS color for any member color, for inline styles. */
export function memberColorCss(c: MemberColor | undefined): string {
  if (isPresetColor(c)) return `var(--member-${c})`
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : "var(--member-blue)"
}

export type MemberRole = "admin" | "adult" | "teen" | "child"

/** Areas a non-admin member can be granted management rights over. */
export type PermissionArea = "calendar" | "chores" | "lists" | "meals" | "members" | "hub"

export const permissionAreas: PermissionArea[] = [
  "calendar",
  "chores",
  "lists",
  "meals",
  "members",
  "hub",
]

export const permissionLabels: Record<PermissionArea, string> = {
  calendar: "Calendar",
  chores: "Chores",
  lists: "Lists",
  meals: "Meals",
  members: "Members",
  hub: "Hub & account",
}

export const permissionDescriptions: Record<PermissionArea, string> = {
  calendar: "Create, edit and delete events and calendars",
  chores: "Create, edit and delete chores",
  lists: "Create, edit and delete lists and items",
  meals: "Plan, edit and delete meals",
  members: "Add, edit and remove family members",
  hub: "Reset hub data, restart the hub and manage the account",
}

export type Member = {
  id: string
  name: string
  initial: string
  color: MemberColor
  role: MemberRole
  dob?: string // ISO date, e.g. "1986-03-14"
  /** Linked auth user id, if this member has claimed/owns an account. */
  userId?: string
  account?: string // connected user account email
  /** Areas this member can manage. Admins implicitly have all areas. */
  permissions?: PermissionArea[]
  /** True while an invite is outstanding and unclaimed. */
  pending?: boolean
}

export const roleLabels: Record<MemberRole, string> = {
  admin: "Admin",
  adult: "Adult",
  teen: "Teen",
  child: "Child",
}

/** Whether a member can manage a given area (admins always can). */
export function memberCan(member: Member | null | undefined, area: PermissionArea): boolean {
  if (!member) return false
  if (member.role === "admin") return true
  return member.permissions?.includes(area) ?? false
}

/** Whole-year age from an ISO date-of-birth string. */
export function calculateAge(dob?: string): number | null {
  if (!dob) return null
  const birth = new Date(dob)
  if (Number.isNaN(birth.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const m = now.getMonth() - birth.getMonth()
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age -= 1
  return age
}

/** Human-friendly DOB, e.g. "Mar 14, 1986". */
export function formatDob(dob?: string): string | null {
  if (!dob) return null
  const d = new Date(dob)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

// Tailwind class maps so preset colors are statically analyzable. A custom
// "#rrggbb" color gets a class written into the page the first time it's used,
// so every `memberBg[color]` lookup works for both.
const customRules = new Set<string>()
let customSheet: CSSStyleSheet | null = null

function customClass(kind: "bg" | "text" | "soft", color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return ""
  const hex = color.slice(1).toLowerCase()
  const cls = `mc-${kind}-${hex}`
  if (!customRules.has(cls) && typeof document !== "undefined") {
    customRules.add(cls)
    if (!customSheet) {
      const el = document.createElement("style")
      el.id = "member-custom-colors"
      document.head.appendChild(el)
      customSheet = el.sheet
    }
    const rule =
      kind === "bg" ? `background-color:#${hex}`
        : kind === "text" ? `color:#${hex}`
          : `background-color:color-mix(in oklab,#${hex} 14%,transparent);color:#${hex}`
    customSheet?.insertRule(`.${cls}{${rule}}`, customSheet.cssRules.length)
  }
  return cls
}

function colorClasses(kind: "bg" | "text" | "soft", presets: Record<PresetColor, string>): Record<MemberColor, string> {
  return new Proxy(presets, {
    get: (target, key) => {
      if (typeof key !== "string") return undefined
      return Object.prototype.hasOwnProperty.call(target, key) ? target[key as PresetColor] : customClass(kind, key)
    },
  }) as Record<MemberColor, string>
}

export const memberBg = colorClasses("bg", {
  coral: "bg-member-coral",
  amber: "bg-member-amber",
  teal: "bg-member-teal",
  blue: "bg-member-blue",
  pink: "bg-member-pink",
  green: "bg-member-green",
})

export const memberText = colorClasses("text", {
  coral: "text-member-coral",
  amber: "text-member-amber",
  teal: "text-member-teal",
  blue: "text-member-blue",
  pink: "text-member-pink",
  green: "text-member-green",
})

// soft tinted background using color-mix for event chips
export const memberSoft = colorClasses("soft", {
  coral: "bg-member-coral/12 text-member-coral",
  amber: "bg-member-amber/15 text-member-amber",
  teal: "bg-member-teal/15 text-member-teal",
  blue: "bg-member-blue/12 text-member-blue",
  pink: "bg-member-pink/12 text-member-pink",
  green: "bg-member-green/15 text-member-green",
})

/** A named calendar (e.g. Family, Friends, Work) that owns events. */
export type Calendar = {
  id: string
  name: string
  color: MemberColor
  /** Members assigned to / sharing this calendar. */
  memberIds: string[]
}

export type CalendarEvent = {
  id: string
  title: string
  /** ISO calendar date, e.g. "2026-06-21". */
  date: string
  /** Display label from older builds; use eventTimeLabel() instead. */
  time: string
  /** Hours since midnight, e.g. 17.5 = 5:30 PM. */
  start: number
  end: number
  /** Last day of an overnight or multi-day event; null/absent when it ends on `date`. */
  endDate?: string | null
  allDay?: boolean
  /** Weekdays the event repeats on (0 = Sunday); empty/absent for one-off events. */
  repeatDays?: number[]
  /** Last date an occurrence can start on; null/absent repeats indefinitely. */
  repeatUntil?: string | null
  /** Occurrence start dates removed from the series ("delete this one"). */
  skipDates?: string[]
  /** Set on a single occurrence expanded from a repeating event (see expandEventsOn). */
  isOccurrence?: boolean
  /** Shown as a countdown tile ("9 sleeps until Christmas"). */
  countdown?: boolean
  /** Minutes before the start to remind the people in it (all-day events count from 9 AM); null for none. */
  reminderMinutes?: number | null
  /** Member who added it; people without the Calendar permission can change only their own. */
  createdBy?: string | null
  /** Members assigned to this event (one event can involve several people). */
  memberIds: string[]
  /** The calendar this event belongs to. */
  calendarId: string
  location?: string
}

/** "5:30 PM" for 17.5. Hour 24 (an event ending at midnight) reads "12:00 AM". */
export function formatClock(hour: number): string {
  const mins = Math.round(hour * 60)
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return toISODate(d)
}

/** Whole days from `a` to `b` (both yyyy-mm-dd). */
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00`).getTime() - new Date(`${a}T00:00:00`).getTime()) / 864e5)
}

/**
 * Start dates of every occurrence of `e` that touches `iso`, earliest first.
 * One-off events have a single occurrence; repeating ones start on each of
 * their weekdays from `date` until `repeatUntil`, minus skipped dates. An
 * overnight occurrence also covers the following day, so back-to-back night
 * shifts can put two occurrences on one day.
 */
export function occurrencesOn(e: CalendarEvent, iso: string): string[] {
  if (!e.repeatDays?.length || e.isOccurrence) return e.date <= iso && iso <= (e.endDate ?? e.date) ? [e.date] : []
  const span = e.endDate ? daysBetween(e.date, e.endDate) : 0
  const starts: string[] = []
  for (let k = span; k >= 0; k--) {
    const start = addDaysISO(iso, -k)
    if (start < e.date) continue
    if (e.repeatUntil && start > e.repeatUntil) continue
    if (!e.repeatDays.includes(new Date(`${start}T00:00:00`).getDay())) continue
    if (e.skipDates?.includes(start)) continue
    starts.push(start)
  }
  return starts
}

/** The latest occurrence of `e` that touches `iso`, or null when it isn't on that day. */
export function occurrenceStartOn(e: CalendarEvent, iso: string): string | null {
  const starts = occurrencesOn(e, iso)
  return starts.length ? starts[starts.length - 1] : null
}

/**
 * The events on `iso`, sorted for display. Each occurrence of a repeating event
 * becomes its own copy with that occurrence's dates and `isOccurrence` set;
 * edits and deletes still go to the series by id.
 */
export function expandEventsOn(events: CalendarEvent[], iso: string): CalendarEvent[] {
  const out: CalendarEvent[] = []
  for (const e of events) {
    for (const start of occurrencesOn(e, iso)) {
      if (!e.repeatDays?.length || e.isOccurrence) { out.push(e); continue }
      const endDate = e.endDate ? addDaysISO(start, daysBetween(e.date, e.endDate)) : null
      out.push({ ...e, date: start, endDate, isOccurrence: true })
    }
  }
  return out.sort(compareEventsOn(iso))
}

/** First and last day of the occurrence covering `iso` (falls back to the event's own dates). */
export function occurrenceOn(e: CalendarEvent, iso: string): { start: string; end: string } {
  const start = occurrenceStartOn(e, iso) ?? e.date
  return { start, end: e.endDate ? addDaysISO(start, daysBetween(e.date, e.endDate)) : start }
}

/** Whether an event is on `iso`, including repeats and the later days of an overnight event. */
export function eventOnDate(e: CalendarEvent, iso: string): boolean {
  return occurrencesOn(e, iso).length > 0
}

/** The short time shown beside an event on `iso`: "5:30 PM", "All day", or "Until 7:00 AM". */
export function eventTimeLabel(e: CalendarEvent, iso: string): string {
  if (e.allDay) return "All day"
  const { start, end } = occurrenceOn(e, iso)
  if (iso > start) return iso < end ? "All day" : `Until ${formatClock(e.end)}`
  return formatClock(e.start)
}

const weekdayLong = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

/** "Every Tuesday", "Every Tue, Thu until Dec 15", "Weekdays"… or null for one-off events. */
export function eventRepeatLabel(e: CalendarEvent): string | null {
  if (!e.repeatDays?.length) return null
  const days = repeatLabel(e.repeatDays)
  const base =
    e.repeatDays.length === 1 ? `Every ${weekdayLong[e.repeatDays[0]]}`
    : days === "Every day" || days === "Weekdays" || days === "Weekends" ? days
    : `Every ${days}`
  if (!e.repeatUntil) return base
  const until = new Date(`${e.repeatUntil}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `${base} until ${until}`
}

/**
 * Countdown events still to come, soonest first, with whole days to go from
 * `todayISO` (0 = today). A repeating event counts down to its next occurrence.
 */
export function upcomingCountdowns(events: CalendarEvent[], todayISO: string, limit = 3): { event: CalendarEvent; days: number }[] {
  const out: { event: CalendarEvent; days: number }[] = []
  for (const e of events) {
    if (!e.countdown) continue
    if (!e.repeatDays?.length) {
      const days = daysBetween(todayISO, e.date)
      if (days >= 0) out.push({ event: e, days })
      continue
    }
    for (let d = 0; d <= 366; d++) {
      const iso = addDaysISO(todayISO, d)
      if (occurrencesOn(e, iso).includes(iso)) { out.push({ event: { ...e, date: iso }, days: d }); break }
    }
  }
  return out.sort((a, b) => a.days - b.days).slice(0, limit)
}

/** "9 sleeps until Christmas", "1 sleep until Christmas", "Christmas is today!" */
export function countdownLabel(title: string, days: number): string {
  if (days === 0) return `${title} is today!`
  return `${days} ${days === 1 ? "sleep" : "sleeps"} until ${title}`
}

/** "5:30 PM – 6:30 PM", "7:00 PM – 7:00 AM next day" overnight, or "Oct 30 – Nov 2" for a trip. */
/** The "Remind" choices in the event form. All-day events are reminded about relative to 9 AM. */
export function reminderOptions(allDay: boolean): { value: number | null; label: string }[] {
  if (allDay) return [{ value: null, label: "None" }, { value: 0, label: "9 AM that day" }, { value: 1440, label: "9 AM the day before" }]
  return [
    { value: null, label: "None" }, { value: 0, label: "At the start" }, { value: 5, label: "5 minutes before" },
    { value: 15, label: "15 minutes before" }, { value: 30, label: "30 minutes before" }, { value: 60, label: "1 hour before" },
    { value: 120, label: "2 hours before" }, { value: 1440, label: "1 day before" },
  ]
}

/** New timed events remind half an hour ahead; all-day ones don't remind unless asked. */
export const defaultReminder = (allDay: boolean): number | null => (allDay ? null : 30)

export function eventRangeLabel(e: CalendarEvent): string {
  if (e.allDay) {
    if (!e.endDate) return "All day"
    const day = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    return `${day(e.date)} – ${day(e.endDate)}`
  }
  const end = formatClock(e.end)
  if (!e.endDate) return `${formatClock(e.start)} – ${end}`
  const next = new Date(`${e.date}T00:00:00`)
  next.setDate(next.getDate() + 1)
  const suffix = e.endDate === toISODate(next) ? "next day" : new Date(`${e.endDate}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
  return `${formatClock(e.start)} – ${end} ${suffix}`
}

/** Sort order within a day: all-day and carried-over events first, then by start time. */
export function compareEventsOn(iso: string) {
  const key = (e: CalendarEvent) => (e.allDay || iso > occurrenceOn(e, iso).start ? -1 : e.start)
  return (a: CalendarEvent, b: CalendarEvent) => key(a) - key(b)
}

/** ISO date (yyyy-mm-dd) for a Date, in local time. */
export function toISODate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

/** The 7 dates of the week containing `ref`, starting Monday. */
export function weekDates(ref: Date): Date[] {
  const base = new Date(ref)
  base.setHours(0, 0, 0, 0)
  const dow = (base.getDay() + 6) % 7 // 0 = Monday
  const monday = new Date(base)
  monday.setDate(base.getDate() - dow)
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return d
  })
}

export type Chore = {
  id: string
  title: string
  memberId: string
  done: boolean
  points: number
  due: string
  /** Weekdays the chore repeats on (0 = Sunday). Absent for one-off chores. */
  repeatDays?: number[]
  /** Date (yyyy-mm-dd) the chore was last completed. */
  doneOn?: string
  /** Picture key from lib/chore-icons.ts, for kids who can't read yet. */
  icon?: string | null
  /** A repeating chore that keeps going in away mode (the dog still eats). */
  keepWhileAway?: boolean
  /** During the house's summer break: the same days, off, only then, or different days (summerDays). */
  summerMode?: SummerMode
  summerDays?: number[]
}

export type SummerMode = "same" | "off" | "only" | "days"
/** The house's summer break (inclusive dates); chores follow their summer rule during it. */
export type Summer = { from: string; until: string }

/** Something points buy, set by a parent. */
export type Reward = { id: string; title: string; cost: number; icon?: string }

/** A member spending points: held while "requested", refunded if "declined". */
export type Redemption = {
  id: string
  rewardId?: string
  memberId: string
  title: string
  cost: number
  status: "requested" | "approved" | "declined"
  createdAt: string
}

export type MemberPoints = {
  memberId: string
  balance: number
  earnedToday: number
  earnedThisWeek: number
  /** Days in a row with a chore checked off. */
  streak: number
}

export type RewardsSummary = { rewards: Reward[]; points: MemberPoints[]; redemptions: Redemption[] }

/** One tile on the wall's home screen. `size`: s = 1×1, m = 2 wide, l = 2×2, full = whole row. */
export type HomeWidget = { id: string; type: string; size: "s" | "m" | "l" | "full"; config?: Record<string, unknown> }
export type HomeLayout = { widgets: HomeWidget[] }

/** The family is away from `from` to `until` (inclusive): repeating chores pause. */
export type Away = { from: string; until: string; label?: string }

const weekdayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

/** Whether a chore is due on `date`: one-off chores always are, repeating ones on their weekdays. */
export function choreDueOn(chore: Chore, date: Date, summer?: Summer | null): boolean {
  if (!chore.repeatDays?.length) return true
  return choreDaysOn(chore, toISODate(date), summer).includes(date.getDay())
}

/** The weekdays a repeating chore runs on, on `iso`: its summer rule during the summer break. */
export function choreDaysOn(chore: Chore, iso: string, summer?: Summer | null): number[] {
  const days = chore.repeatDays ?? []
  const mode = chore.summerMode ?? "same"
  const inSummer = !!summer && iso >= summer.from && iso <= summer.until
  if (!inSummer) return mode === "only" ? [] : days
  return mode === "off" ? [] : mode === "days" ? chore.summerDays ?? [] : days
}

/** Whether a repeating chore stops for away mode; ones marked "keep going" don't. */
export function pausesWhileAway(chore: Chore): boolean {
  return !!chore.repeatDays?.length && !chore.keepWhileAway
}

/** Whether a chore counts as done on `todayISO`. Repeating chores reset every day. */
export function choreDone(chore: Chore, todayISO: string): boolean {
  return chore.repeatDays?.length ? chore.doneOn === todayISO : chore.done
}

/** "Every day", "Weekdays", "Weekends" or "Mon, Wed, Fri". */
export function repeatLabel(days: number[]): string {
  const set = [...new Set(days)].sort()
  const key = set.join(",")
  if (key === "0,1,2,3,4,5,6") return "Every day"
  if (key === "1,2,3,4,5") return "Weekdays"
  if (key === "0,6") return "Weekends"
  // Monday-first, matching the week strip.
  return [1, 2, 3, 4, 5, 6, 0].filter((d) => set.includes(d)).map((d) => weekdayShort[d]).join(", ")
}

/** The schedule line shown under a chore: its repeat days, or its one-off due label. */
export function choreSchedule(chore: Chore): string {
  if (!chore.repeatDays?.length) return chore.due
  const base = repeatLabel(chore.repeatDays)
  switch (chore.summerMode) {
    case "off": return `${base} · not in summer`
    case "only": return `${base} · summer only`
    case "days": return chore.summerDays?.length ? `${base} · ${repeatLabel(chore.summerDays)} in summer` : `${base} · not in summer`
    default: return base
  }
}

/** `addedBy` is the member who added it (null at the wall); they may rename or remove it. */
export type ListItem = { id: string; label: string; done: boolean; addedBy?: string | null }
export type Checklist = {
  id: string
  title: string
  color: MemberColor
  items: ListItem[]
}

export type Meal = {
  id: string
  /** yyyy-mm-dd for a one-day menu (Christmas Eve); absent = every week on `day`. */
  date?: string | null
  /** Grocery lines that "Add to Groceries" sends to the grocery list. */
  ingredients?: string[]
  day: string
  name: string
  type: string
  image?: string
  memberId: string
}

export type Photo = {
  id: string
  src: string
  caption: string
  createdAt?: string
}

export type Notification = {
  id: string
  title: string
  body: string
  time: string
  memberId: string
  /** What it's about: "reminder:<event>:<date>", "redemption:<id>", "member:<id>". */
  ref?: string
  /** Per-user read state for the signed-in member (notifications are shared,
   * but read/dismiss state is tracked per person). */
  read: boolean
}

// Live data is loaded via the API client (src/lib/api.ts) and held in the
// shared store (src/lib/store.tsx). This module now only defines types and
// pure presentation helpers — no seed/dummy data.
