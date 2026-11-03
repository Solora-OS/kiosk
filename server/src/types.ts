/**
 * types.ts — shared TypeScript types for the Solora local server.
 *
 * These mirror the frontend types in src/lib/data.ts and src/lib/api.ts.
 * Keep them in sync when the frontend contract changes.
 */

// ---------------------------------------------------------------------------
// Domain types (mirror frontend data.ts)
// ---------------------------------------------------------------------------

/** A theme preset, or a custom "#rrggbb" picked by hand. */
export type MemberColor = "coral" | "amber" | "teal" | "blue" | "pink" | "green" | `#${string}`
export type MemberRole = "admin" | "adult" | "teen" | "child"
export type PermissionArea = "calendar" | "chores" | "lists" | "meals" | "members" | "hub"

export type Household = {
  id: string
  name: string
  createdAt: string
}

export type User = {
  id: string
  householdId: string
  email: string
  name: string
  createdAt: string
}

export type Member = {
  id: string
  householdId: string
  userId?: string
  name: string
  initial: string
  color: MemberColor
  role: MemberRole
  dob?: string
  account?: string
  permissions: PermissionArea[]
  pending: boolean
  createdAt: string
}

export type Invite = {
  id: string
  householdId: string
  memberId: string
  token: string
  code: string
  name: string
  role: MemberRole
  color: MemberColor
  dob?: string
  email?: string
  expiresAt: string
  createdAt: string
}

export type Calendar = {
  id: string
  householdId: string
  name: string
  color: MemberColor
  memberIds: string[]
  createdAt: string
}

export type CalendarEvent = {
  id: string
  householdId: string
  calendarId?: string
  title: string
  date: string
  /** Last day of an overnight or multi-day event; absent when it ends on `date`. */
  endDate?: string
  allDay: boolean
  /** Weekdays a repeating event recurs on (0 = Sunday); absent for one-off events. */
  repeatDays?: number[]
  /** Last date an occurrence can start on; absent = repeats indefinitely. */
  repeatUntil?: string
  /** Occurrence start dates removed from the series. */
  skipDates: string[]
  /** Shown as a countdown tile ("9 sleeps until Christmas"). */
  countdown: boolean
  time?: string
  /** Hours since midnight, e.g. 17.5 = 5:30 PM. */
  start: number
  end: number
  /** @deprecated Same as start/end; kept for older clients. */
  startHour: number
  endHour: number
  memberIds: string[]
  location?: string
  createdAt: string
  source?: string
  /** Minutes before the start to remind; all-day events count from 9 AM. Null: no reminder. */
  reminderMinutes: number | null
  /** Member who added the event; null for imported events and older ones. */
  createdBy: string | null
}

export type Chore = {
  id: string
  householdId: string
  memberId?: string
  title: string
  done: boolean
  points: number
  due: string
  /** Weekdays the chore repeats on (0 = Sunday). Absent for one-off chores. */
  repeatDays?: number[]
  /** Hub-local date (yyyy-mm-dd) the chore was last completed. */
  doneOn?: string
  /** Picture key shown for the chore (the apps' chore-icons list). */
  icon?: string
  /** A repeating chore that keeps going in away mode (the dog still eats). */
  keepWhileAway: boolean
  /** During summer break: same days, off, only then, or different days (summerDays). */
  summerMode: "same" | "off" | "only" | "days"
  summerDays?: number[]
  createdAt: string
}

export type ListItem = {
  id: string
  listId: string
  label: string
  done: boolean
  position: number
  /** Member who added it; null when added at the wall. */
  addedBy: string | null
  createdAt: string
}

export type ChecklistRow = {
  id: string
  householdId: string
  title: string
  color: MemberColor
  createdAt: string
}

export type Checklist = ChecklistRow & { items: ListItem[] }

export type Meal = {
  /** yyyy-mm-dd for a one-day menu; absent = every week on `day`. */
  date?: string
  /** Grocery lines to send to a list. */
  ingredients: string[]
  id: string
  householdId: string
  memberId?: string
  day: string
  name: string
  type: string
  image?: string
  createdAt: string
}

export type Notification = {
  id: string
  householdId: string
  memberId?: string
  title: string
  body: string
  time: string
  /** What it's about: "reminder:<event>:<date>", "redemption:<id>", "member:<id>". */
  ref?: string
  createdAt: string
}

export type NotificationWithState = Notification & { read: boolean }

export type Photo = {
  id: string
  householdId: string
  filename: string
  src: string
  caption: string
  createdAt: string
}

export type KioskDevice = {
  id: string
  householdId: string
  name: string
  deviceToken: string
  lastSeen?: string
  online: boolean
  createdAt: string
}

// ---------------------------------------------------------------------------
// Auth types
// ---------------------------------------------------------------------------

export type JwtPayload = {
  sub: string           // user id OR kiosk device id
  householdId?: string  // absent for unregistered kiosk tokens
  email?: string        // absent for kiosk tokens
  name?: string         // absent for kiosk tokens
  role?: "kiosk" | "member" | "admin"
  /** "refresh" marks a refresh token, which is never accepted as an access token. */
  typ?: "refresh" | "presence"
  iat?: number
  exp?: number
}

// ---------------------------------------------------------------------------
// Hub remote-command types
// ---------------------------------------------------------------------------

export type HubCommand =
  | { type: "restart" }
  | { type: "reload" }
  | { type: "clear_cache" }
  | { type: "set_orientation"; orientation: "normal" | "left" | "right" | "inverted" | "portrait" }
  | { type: "set_idle_mins"; minutes: number | null }
  | { type: "set_brightness"; level: number }
  | { type: "set_volume"; level: number }
  | { type: "set_muted"; muted: boolean }
  | { type: "set_theme"; theme: "light" | "dark" | "system" }
  | { type: "set_season"; mode: string }
  | { type: "set_season_effects"; on: boolean }
  | { type: "display_sleep" }
  | { type: "display_wake" }

/**
 * What a wall display reports about itself so a phone can show (and change)
 * its current settings. Every field is optional: a display only sends what
 * its hardware can actually do (no backlight → no brightness).
 */
export type DisplayState = {
  brightness?: number | null
  volume?: number | null
  muted?: boolean
  theme?: "light" | "dark" | "system"
  seasonMode?: string
  seasonEffects?: boolean
  /** Seasons this display can show, built-in and imported. */
  seasons?: { id: string; label: string }[]
  orientation?: string | null
  slideshowIdleMins?: number | null
  asleep?: boolean
}

/** What a phone can throw onto the wall it's standing at (routes/wall.ts). */
export type WallThrowKind = "photo" | "list"

/** A family member, as a wall shows them when they walk up or throw something. */
export type WallMember = { id: string; name: string; color: string }

// ---------------------------------------------------------------------------
// Socket.IO event map
// ---------------------------------------------------------------------------

/** Events emitted FROM the server TO clients. */
export type ServerToClientEvents = {
  // table:action e.g. "members:created", "events:updated", "chores:deleted"
  "members:created": (row: Member) => void
  "members:updated": (row: Member) => void
  "members:deleted": (id: string) => void

  "calendars:created": (row: Calendar) => void
  "calendars:updated": (row: Calendar) => void
  "calendars:deleted": (id: string) => void

  "events:created": (row: CalendarEvent) => void
  "events:updated": (row: CalendarEvent) => void
  "events:deleted": (id: string) => void

  "chores:created": (row: Chore) => void
  "chores:updated": (row: Chore) => void
  "chores:deleted": (id: string) => void

  "lists:created": (row: Checklist) => void
  "lists:updated": (row: Checklist) => void
  "lists:deleted": (id: string) => void

  "meals:created": (row: Meal) => void
  "meals:updated": (row: Meal) => void
  "meals:deleted": (id: string) => void

  "notifications:created": (row: NotificationWithState) => void
  "notifications:updated": (row: NotificationWithState) => void
  "notifications:deleted": (id: string) => void

  "photos:created": (row: Photo) => void
  "photos:deleted": (id: string) => void
  /** Household-wide settings changed (seasons); clients re-read the snapshot. */
  "households:updated": (row: Record<string, never>) => void

  "hub:command": (cmd: HubCommand) => void
  "display:state": (payload: { deviceId: string; state: DisplayState; updatedAt: string }) => void

  /** A phone is standing at these walls (Bluetooth); they wake for it. */
  "wall:approach": (payload: { deviceIds: string[]; member: WallMember }) => void
  /** Pinch to throw: show this photo or list full screen on these walls. */
  "wall:throw": (payload: { deviceIds: string[]; kind: WallThrowKind; id: string; from: WallMember }) => void
}

/** Events emitted FROM clients TO the server (currently none needed server-side). */
export type ClientToServerEvents = Record<string, never>

/** Per-socket data stored by the auth middleware. */
export type SocketData = {
  userId: string
  householdId: string
  email: string
  name: string
}
