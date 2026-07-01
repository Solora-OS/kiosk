// ---------------------------------------------------------------------------
// Lumora API — contract types + active adapter
//
// All data flow is now local-only. The Supabase and in-memory mock adapters
// have been removed. The single active adapter is `createLocalApi()` from
// local-api.ts, which talks to the local Express + Socket.IO server running
// as a systemd service on the kiosk machine.
// ---------------------------------------------------------------------------

import type {
  MemberColor,
  MemberRole,
  PermissionArea,
  Calendar,
  CalendarEvent,
  Chore,
  Checklist,
  Meal,
  Notification,
  Photo,
} from "./data"

// ----- Contract types (shared with server/src/types.ts) --------------------

export type User = {
  id: string
  email: string
  name: string
}

export type Household = {
  id: string
  name: string
}

/** A member belongs to a household and may be linked to a user account. */
export type ApiMember = {
  id: string
  householdId: string
  name: string
  color: MemberColor
  role: MemberRole
  dob?: string
  /** Linked account id, if this member has claimed/owns an account. */
  userId?: string
  /** Linked account email, for display. */
  account?: string
  /** Areas this member can manage (non-admins only; admins have all). */
  permissions?: PermissionArea[]
  /** True while an invite is outstanding and unclaimed. */
  pending?: boolean
}

export type Invite = {
  /** Database row id — used to cancel/revoke the invite. */
  id: string
  /** Opaque token embedded in the QR code. */
  token: string
  /** Short human-typable fallback code, e.g. "K3F-9Q2". */
  code: string
  householdId: string
  householdName: string
  /** The member slot this invite will fill once claimed. */
  memberId: string
  memberName: string
  role: MemberRole
  /** Prefilled email for the invited person's account (admin-provided). */
  email?: string
  expiresAt: string
}

export type Session = {
  user: User
  household: Household
}

export type SignUpInput = {
  name: string
  email: string
  password: string
  /** Optional household name when creating a brand-new family. */
  householdName?: string
}

export type SignInInput = { email: string; password: string }

export type CreateMemberInput = {
  name: string
  color: MemberColor
  role: MemberRole
  dob?: string
  /** Connected user account email, for display. */
  account?: string
  /** Areas this member can manage (non-admins only). */
  permissions?: PermissionArea[]
  /** Link this new member to the current signed-in user ("this is me"). */
  linkSelf?: boolean
}

export type CreateInviteInput = {
  name: string
  role: MemberRole
  color: MemberColor
  dob?: string
  /** Attach the invite to an existing member slot instead of creating a new one. */
  memberId?: string
  /** Prefilled email for the invited person's account. */
  email?: string
}

export type ClaimInviteInput = {
  token: string
  name: string
  email: string
  password: string
  dob?: string
  color?: MemberColor
}

export type ApiError = { error: string }

export interface LumoraApi {
  signUp(input: SignUpInput): Promise<Session & { token: string }>
  signIn(input: SignInInput): Promise<Session & { token: string }>
  /** Kiosk-only: ask hub server to sign in using server-side credentials. No password in frontend. */
  kioskAutoSignIn(): Promise<(Session & { token: string }) | null>
  signOut(): Promise<void>
  getSession(): Promise<Session | null>

  listMembers(): Promise<ApiMember[]>
  createMember(input: CreateMemberInput): Promise<ApiMember>
  updateMember(id: string, patch: Partial<CreateMemberInput>): Promise<ApiMember>
  deleteMember(id: string): Promise<void>

  /** Create an unclaimed member slot + invite (returns QR token + code). */
  createInvite(input: CreateInviteInput): Promise<Invite>
  /** Revoke an outstanding invite (clears pending flag on the member slot). */
  deleteInvite(id: string): Promise<void>
  /** Look up an invite by token or code (for the claim screen preview). */
  getInvite(tokenOrCode: string): Promise<Invite | null>
  /** Invited person creates their account + profile, claiming the slot. */
  claimInvite(input: ClaimInviteInput): Promise<Session & { token: string }>

  // calendars
  listCalendars(): Promise<Calendar[]>
  createCalendar(input: Omit<Calendar, "id">): Promise<Calendar>
  updateCalendar(id: string, patch: Partial<Omit<Calendar, "id">>): Promise<Calendar>
  deleteCalendar(id: string): Promise<void>

  // events
  listEvents(): Promise<CalendarEvent[]>
  createEvent(input: Omit<CalendarEvent, "id">): Promise<CalendarEvent>
  updateEvent(id: string, patch: Partial<Omit<CalendarEvent, "id">>): Promise<CalendarEvent>
  deleteEvent(id: string): Promise<void>

  // chores
  listChores(): Promise<Chore[]>
  createChore(input: Omit<Chore, "id">): Promise<Chore>
  updateChore(id: string, patch: Partial<Omit<Chore, "id">>): Promise<Chore>
  deleteChore(id: string): Promise<void>

  // lists (items are nested; item mutations return the updated list)
  listLists(): Promise<Checklist[]>
  createList(input: { title: string; color: MemberColor }): Promise<Checklist>
  updateList(id: string, patch: { title?: string; color?: MemberColor }): Promise<Checklist>
  deleteList(id: string): Promise<void>
  addListItem(listId: string, label: string): Promise<Checklist>
  updateListItem(listId: string, itemId: string, patch: { label?: string; done?: boolean }): Promise<Checklist>
  deleteListItem(listId: string, itemId: string): Promise<Checklist>

  // meals
  listMeals(): Promise<Meal[]>
  createMeal(input: Omit<Meal, "id">): Promise<Meal>
  updateMeal(id: string, patch: Partial<Omit<Meal, "id">>): Promise<Meal>
  deleteMeal(id: string): Promise<void>

  // notifications
  listNotifications(): Promise<Notification[]>
  createNotification(input: Omit<Notification, "id">): Promise<Notification>
  updateNotification(id: string, patch: Partial<Omit<Notification, "id">>): Promise<Notification>
  deleteNotification(id: string): Promise<void>
  markAllNotificationsRead(): Promise<void>
  clearNotifications(): Promise<void>

  // photos
  listPhotos(): Promise<Photo[]>
  createPhoto(input: Omit<Photo, "id">): Promise<Photo>
  /** Multipart upload — sends the raw File to POST /photos on the local server. */
  uploadPhoto(file: File, caption?: string): Promise<Photo>
  deletePhoto(id: string): Promise<void>
}

// ----- Token storage (re-exported from local-api for backward compat) ------

export { tokenStore } from "./local-api"

// ----- Mutation guard -------------------------------------------------------
//
// Live-sync via Socket.IO fires immediately on mutations. To avoid a socket
// echo clobbering an optimistic local change that hasn't round-tripped yet,
// every mutating call stamps `lastMutationAt`; the live handler skips
// reconciling for a short grace window afterwards.

export const syncGuard = {
  lastMutationAt: 0,
  note() { this.lastMutationAt = Date.now() },
  isBusy(ms = 3000) { return Date.now() - this.lastMutationAt < ms },
}

/** Method names that change server state (vs. read-only list*/
const MUTATING_METHODS = new Set<keyof LumoraApi>([
  "createMember", "updateMember", "deleteMember",
  "createInvite", "deleteInvite", "claimInvite",
  "createCalendar", "updateCalendar", "deleteCalendar",
  "createEvent", "updateEvent", "deleteEvent",
  "createChore", "updateChore", "deleteChore",
  "createList", "updateList", "deleteList",
  "addListItem", "updateListItem", "deleteListItem",
  "createMeal", "updateMeal", "deleteMeal",
  "createNotification", "updateNotification", "deleteNotification",
  "markAllNotificationsRead", "clearNotifications",
  "createPhoto", "uploadPhoto", "deletePhoto",
])

function withMutationGuard(adapter: LumoraApi): LumoraApi {
  const wrapped = {} as Record<string, unknown>
  for (const key of Object.keys(adapter) as (keyof LumoraApi)[]) {
    const fn = adapter[key]
    if (typeof fn === "function" && MUTATING_METHODS.has(key)) {
      wrapped[key] = (...args: unknown[]) => {
        syncGuard.note()
        return (fn as (...a: unknown[]) => unknown).apply(adapter, args)
      }
    } else if (typeof fn === "function") {
      wrapped[key] = (fn as (...a: unknown[]) => unknown).bind(adapter)
    } else {
      wrapped[key] = fn
    }
  }
  return wrapped as unknown as LumoraApi
}

// ----- Active adapter -------------------------------------------------------

import { createLocalApi } from "./local-api"

export const api: LumoraApi = withMutationGuard(createLocalApi())
