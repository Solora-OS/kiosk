// ---------------------------------------------------------------------------
// Lumora local API client
//
// Replaces all Supabase / cloud adapters. Talks exclusively to the local
// Express + Socket.IO server running at http://<kiosk-ip>:4000 (systemd
// service: lumora-server). During development VITE_LOCAL_API_URL defaults
// to http://localhost:4000.
//
// Auth flow:
//   1. signUp / signIn hit POST /auth/register or POST /auth/login.
//   2. The server returns { token, refreshToken, user, household }.
//   3. token is stored in localStorage under "lumora.token".
//   4. Every subsequent request carries Authorization: Bearer <token>.
//   5. Socket.IO handshake carries the same token in auth.token.
//
// Live updates:
//   The exported `liveSocket` connects once a token exists and joins the
//   "household:<id>" room. Every DB mutation the server performs emits a
//   "<table>:<action>" event (e.g. "events:created") with the affected row.
//   store.tsx subscribes to these events and reconciles local state.
// ---------------------------------------------------------------------------

import { io, type Socket } from "socket.io-client"
import type {
  LumoraApi,
  ApiMember,
  User,
  Household,
  Session,
  SignUpInput,
  SignInInput,
  CreateMemberInput,
  CreateInviteInput,
  ClaimInviteInput,
  Invite,
} from "./api"
import type {
  Calendar,
  CalendarEvent,
  Chore,
  Checklist,
  Meal,
  Notification,
  Photo,
  MemberColor,
  MemberRole,
} from "./data"

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Base URL of the local Express server.
 *
 *  In development the Vite proxy forwards /api, /socket.io and /photo-files
 *  to localhost:4000, so we use an empty string (same-origin) — this avoids
 *  all CORS / access-control errors in the browser preview.
 *
 *  In production (Tauri or a custom deploy) VITE_LUMORA_SERVER_URL must be
 *  set to the full server address, e.g. "http://192.168.1.10:4000".
 */
export const LOCAL_API_BASE =
  import.meta.env.VITE_LUMORA_SERVER_URL?.replace(/\/$/, "") ??
  "http://127.0.0.1:4000";

const API = `${LOCAL_API_BASE}/api/v1`;


// ---------------------------------------------------------------------------
// Token storage (same key kept for backward compat with tokenStore in api.ts)
// ---------------------------------------------------------------------------

const TOKEN_KEY        = "lumora.token"
const DEVICE_TOKEN_KEY = "lumora.kiosk.deviceToken"

/** Read the kiosk device JWT directly — avoids a circular import with kiosk-session.ts. */
function getDeviceToken(): string | null {
  try { return localStorage.getItem(DEVICE_TOKEN_KEY) } catch { return null }
}
const REFRESH_KEY = "lumora.refresh"

type TokenListener = () => void
const tokenListeners = new Set<TokenListener>()

export const tokenStore = {
  get(): string | null {
    try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
  },
  set(token: string) {
    try {
      localStorage.setItem(TOKEN_KEY, token)
      tokenListeners.forEach((fn) => fn())
    } catch { /* ignore */ }
  },
  clear() {
    try { localStorage.removeItem(TOKEN_KEY); localStorage.removeItem(REFRESH_KEY) } catch { /* ignore */ }
  },
  /** Subscribe to token changes. Returns an unsubscribe function. */
  subscribe(fn: TokenListener): () => void {
    tokenListeners.add(fn)
    return () => tokenListeners.delete(fn)
  },
  getRefresh(): string | null {
    try { return localStorage.getItem(REFRESH_KEY) } catch { return null }
  },
  setRefresh(token: string) {
    try { localStorage.setItem(REFRESH_KEY, token) } catch { /* ignore */ }
  },
}

// ---------------------------------------------------------------------------
// Cached session state (avoids repeated /auth/me round-trips)
// ---------------------------------------------------------------------------

let _cachedUser: User | null = null
let _cachedHousehold: Household | null = null

export function setCachedSession(user: User | null, household: Household | null) {
  _cachedUser = user
  _cachedHousehold = household
}

export function getCachedSession(): Session | null {
  if (_cachedUser && _cachedHousehold) return { user: _cachedUser, household: _cachedHousehold }
  return null
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req<T>(path: string, method: string, body?: unknown): Promise<T> {
  // Prefer the user token (lumora.token); fall back to the kiosk device token
  // (lumora.kiosk.deviceToken) so API calls work before the bridge in
  // kiosk-provider.tsx has had a chance to copy it into tokenStore.
  const token = tokenStore.get() ?? getDeviceToken()
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body != null ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = await res.json() as { error?: string }
      if (data?.error) message = data.error
    } catch { /* ignore */ }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Row -> domain type mappers (mirror server responses)
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>

function toMember(r: Row): ApiMember {
  return {
    id: r.id as string,
    householdId: (r.household_id ?? r.householdId) as string,
    name: r.name as string,
    color: r.color as MemberColor,
    role: r.role as MemberRole,
    dob: (r.dob ?? undefined) as string | undefined,
    userId: (r.user_id ?? r.userId ?? undefined) as string | undefined,
    account: (r.account ?? undefined) as string | undefined,
    permissions: (r.permissions as string[] | undefined) ?? [],
    pending: (r.pending as boolean | undefined) ?? false,
  }
}

function toCalendar(r: Row): Calendar {
  return {
    id: r.id as string,
    name: r.name as string,
    color: r.color as MemberColor,
    memberIds: (r.member_ids ?? r.memberIds ?? []) as string[],
  }
}

function toEvent(r: Row): CalendarEvent {
  return {
    id: r.id as string,
    title: r.title as string,
    date: r.date as string,
    time: (r.time ?? "") as string,
    start: Number(r.start_hour ?? r.start) || 0,
    end: Number(r.end_hour ?? r.end) || 0,
    memberIds: (r.member_ids ?? r.memberIds ?? []) as string[],
    calendarId: (r.calendar_id ?? r.calendarId ?? "") as string,
    location: (r.location ?? undefined) as string | undefined,
  }
}

function toChore(r: Row): Chore {
  return {
    id: r.id as string,
    title: r.title as string,
    memberId: (r.member_id ?? r.memberId ?? "") as string,
    done: (r.done as boolean | undefined) ?? false,
    points: Number(r.points) || 0,
    due: (r.due ?? "") as string,
  }
}

function toMeal(r: Row): Meal {
  return {
    id: r.id as string,
    day: r.day as string,
    name: r.name as string,
    type: r.type as string,
    image: (r.image ?? undefined) as string | undefined,
    memberId: (r.member_id ?? r.memberId ?? "") as string,
  }
}

function toNotification(r: Row): Notification {
  return {
    id: r.id as string,
    title: r.title as string,
    body: (r.body ?? "") as string,
    time: (r.time ?? "") as string,
    memberId: (r.member_id ?? r.memberId ?? "") as string,
    read: (r.read as boolean | undefined) ?? false,
  }
}

function toPhoto(r: Row): Photo {
  // The server stores a relative path; we prefix with the API base so <img>
  // tags resolve correctly when served from any kiosk IP on the LAN.
  const rawSrc = (r.src ?? r.file_path ?? "") as string
  const src = rawSrc.startsWith("http") ? rawSrc : `${LOCAL_API_BASE}${rawSrc}`
  return { id: r.id as string, src, caption: (r.caption ?? "") as string, createdAt: (r.created_at ?? r.createdAt ?? undefined) as string | undefined }
}

function toInvite(r: Row): Invite {
  return {
    id: r.id as string,
    token: r.token as string,
    code: r.code as string,
    householdId: (r.household_id ?? r.householdId) as string,
    householdName: (r.household_name ?? r.householdName ?? "") as string,
    memberId: (r.member_id ?? r.memberId) as string,
    memberName: (r.member_name ?? r.memberName ?? "") as string,
    role: r.role as MemberRole,
    email: (r.email ?? undefined) as string | undefined,
    expiresAt: (r.expires_at ?? r.expiresAt ?? "") as string,
  }
}

// Checklist is assembled from list + items (server returns them nested or flat)
function toChecklist(r: Row): Checklist {
  const items = ((r.items ?? []) as Row[]).map((i) => ({
    id: i.id as string,
    label: i.label as string,
    done: (i.done as boolean | undefined) ?? false,
  }))
  return {
    id: r.id as string,
    title: r.title as string,
    color: r.color as MemberColor,
    items,
  }
}

// ---------------------------------------------------------------------------
// Socket.IO live client
// ---------------------------------------------------------------------------

/** Event name emitted by the server for every table mutation. */
export type LiveEvent = {
  table: string
  action: "created" | "updated" | "deleted"
  row: Row
  householdId: string
}

export type HubCommandEvent =
  | { type: "restart" }
  | { type: "reload" }
  | { type: "clear_cache" }
  | { type: "set_orientation"; orientation: "normal" | "left" | "right" | "inverted" | "portrait" }
  | { type: "set_idle_mins"; minutes: number | null }

type LiveListener = (event: LiveEvent) => void
type HubCommandListener = (cmd: HubCommandEvent) => void

class LiveSocket {
  private socket: Socket | null = null
  private listeners = new Set<LiveListener>()
  private hubCommandListeners = new Set<HubCommandListener>()
  private householdId: string | null = null

  connect(householdId: string) {
    if (this.socket?.connected && this.householdId === householdId) return
    this.disconnect()
    this.householdId = householdId

    this.socket = io(LOCAL_API_BASE, {
      auth: { token: tokenStore.get() ?? getDeviceToken() ?? "" },
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 2000,
    })

    this.socket.on("connect", () => {
      this.socket!.emit("join", { householdId })
    })

    // The server broadcasts events as "<table>:<action>", e.g. "events:created".
    // We also handle a generic "db_change" envelope in case the server emits that.
    const tables = [
      "members", "invites", "calendars", "events", "chores",
      "lists", "list_items", "meals", "notifications", "photos",
      "households", "kiosk_devices",
    ]
    for (const table of tables) {
      for (const action of ["created", "updated", "deleted"] as const) {
        this.socket.on(`${table}:${action}`, (row: Row) => {
          this.emit({ table, action, row, householdId })
        })
      }
    }

    this.socket.on("hub:command", (cmd: HubCommandEvent) => {
      for (const l of this.hubCommandListeners) l(cmd)
    })
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.householdId = null
  }

  subscribe(cb: LiveListener): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** Subscribe to hub remote commands. Returns an unsubscribe function. */
  subscribeHubCommand(cb: HubCommandListener): () => void {
    this.hubCommandListeners.add(cb)
    return () => this.hubCommandListeners.delete(cb)
  }

  private emit(event: LiveEvent) {
    for (const l of this.listeners) l(event)
  }

  get connected(): boolean {
    return this.socket?.connected ?? false
  }
}

/** Singleton live socket — shared across the app. */
export const liveSocket = new LiveSocket()

// ---------------------------------------------------------------------------
// Hub remote-command helpers
// ---------------------------------------------------------------------------

export type HubCommandPayload =
  | { type: "restart" }
  | { type: "reload" }
  | { type: "clear_cache" }
  | { type: "set_orientation"; orientation: "normal" | "left" | "right" | "inverted" | "portrait" }
  | { type: "set_idle_mins"; minutes: number | null }

/**
 * Ask the server to broadcast a hub command to all kiosk devices in the household.
 * The kiosk receives the Socket.IO "hub:command" event and executes the action locally.
 */
export async function sendHubCommand(cmd: HubCommandPayload): Promise<void> {
  await req<{ ok: boolean }>("/hub/command", "POST", cmd)
}

// ---------------------------------------------------------------------------
// LumoraApi implementation backed by the local server
// ---------------------------------------------------------------------------

export function createLocalApi(): LumoraApi {
  return {
    // ----- auth -----
    async signUp(input: SignUpInput) {
      const res = await req<{ token: string; refreshToken: string; user: User; household: Household }>(
        "/auth/register", "POST", {
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          password: input.password,
          household_name: input.householdName?.trim() ?? `${input.name.trim()}'s Family`,
        }
      )
      tokenStore.set(res.token)
      tokenStore.setRefresh(res.refreshToken)
      setCachedSession(res.user, res.household)
      liveSocket.connect(res.household.id)
      return { token: res.token, user: res.user, household: res.household }
    },

    async signIn(input: SignInInput) {
      const res = await req<{ token: string; refreshToken: string; user: User; household: Household }>(
        "/auth/login", "POST", {
          email: input.email.trim().toLowerCase(),
          password: input.password,
        }
      )
      tokenStore.set(res.token)
      tokenStore.setRefresh(res.refreshToken)
      setCachedSession(res.user, res.household)
      liveSocket.connect(res.household.id)
      return { token: res.token, user: res.user, household: res.household }
    },

    async kioskAutoSignIn() {
      // Calls the hub server which reads credentials from ~/.lumora/kiosk-autologin.json.
      // No credentials are ever sent from or stored in the frontend.
      try {
        const res = await req<{ token: string; user: User; household: Household } | { enabled: false }>(
          "/auth/kiosk-autologin", "POST"
        )
        if (!("token" in res)) return null
        tokenStore.set(res.token)
        setCachedSession(res.user, res.household)
        liveSocket.connect(res.household.id)
        return { token: res.token, user: res.user, household: res.household }
      } catch {
        return null
      }
    },

    async signOut() {
      try { await req("/auth/logout", "POST") } catch { /* ignore */ }
      tokenStore.clear()
      setCachedSession(null, null)
      liveSocket.disconnect()
    },

    async getSession() {
      const cached = getCachedSession()
      if (cached) return cached
      try {
        const res = await req<{ user: User; household: Household }>("/auth/me", "GET")
        setCachedSession(res.user, res.household)
        if (res.household?.id) liveSocket.connect(res.household.id)
        return { user: res.user, household: res.household }
      } catch {
        return null
      }
    },

    // ----- members -----
    async listMembers() {
      const rows = await req<Row[]>("/members", "GET")
      return rows.map(toMember)
    },
    async createMember(input: CreateMemberInput) {
      const row = await req<Row>("/members", "POST", {
        name: input.name.trim(),
        color: input.color,
        role: input.role,
        dob: input.dob ?? null,
        account: input.account ?? null,
        user_id: null,
        permissions: input.role === "admin" ? [] : (input.permissions ?? []),
        pending: false,
      })
      return toMember(row)
    },
    async updateMember(id: string, patch: Partial<CreateMemberInput>) {
      const body: Row = {}
      if (patch.name !== undefined) body.name = patch.name.trim()
      if (patch.color !== undefined) body.color = patch.color
      if (patch.role !== undefined) body.role = patch.role
      if (patch.dob !== undefined) body.dob = patch.dob ?? null
      if (patch.account !== undefined) body.account = patch.account ?? null
      if (patch.permissions !== undefined) body.permissions = patch.permissions ?? []
      const row = await req<Row>(`/members/${id}`, "PATCH", body)
      return toMember(row)
    },
    async deleteMember(id: string) {
      await req(`/members/${id}`, "DELETE")
    },

    // ----- invites -----
    async createInvite(input: CreateInviteInput) {
      const row = await req<Row>("/invites", "POST", {
        member_id: input.memberId ?? null,
        name: input.name.trim(),
        role: input.role,
        color: input.color,
        dob: input.dob ?? null,
        email: input.email ?? null,
      })
      return toInvite(row)
    },
    async getInvite(tokenOrCode: string) {
      try {
        const row = await req<Row>(`/invites/${encodeURIComponent(tokenOrCode)}`, "GET")
        return toInvite(row)
      } catch {
        return null
      }
    },
    async deleteInvite(id: string) {
      await req(`/invites/${id}`, "DELETE")
    },
    async claimInvite(input: ClaimInviteInput) {
      const res = await req<{ token: string; refreshToken: string; user: User; household: Household }>(
        "/invites/claim", "POST", {
          token: input.token,
          name: input.name.trim(),
          email: input.email.trim().toLowerCase(),
          password: input.password,
          dob: input.dob ?? null,
          color: input.color ?? null,
        }
      )
      tokenStore.set(res.token)
      tokenStore.setRefresh(res.refreshToken)
      setCachedSession(res.user, res.household)
      liveSocket.connect(res.household.id)
      return { token: res.token, user: res.user, household: res.household }
    },

    // ----- calendars -----
    async listCalendars() {
      const rows = await req<Row[]>("/calendars", "GET")
      return rows.map(toCalendar)
    },
    async createCalendar(input: Omit<Calendar, "id">) {
      const row = await req<Row>("/calendars", "POST", {
        name: input.name,
        color: input.color,
        member_ids: input.memberIds ?? [],
      })
      return toCalendar(row)
    },
    async updateCalendar(id: string, patch: Partial<Omit<Calendar, "id">>) {
      const body: Row = {}
      if (patch.name !== undefined) body.name = patch.name
      if (patch.color !== undefined) body.color = patch.color
      if (patch.memberIds !== undefined) body.member_ids = patch.memberIds
      const row = await req<Row>(`/calendars/${id}`, "PATCH", body)
      return toCalendar(row)
    },
    async deleteCalendar(id: string) {
      await req(`/calendars/${id}`, "DELETE")
    },

    // ----- events -----
    async listEvents() {
      const rows = await req<Row[]>("/events", "GET")
      return rows.map(toEvent)
    },
    async createEvent(input: Omit<CalendarEvent, "id">) {
      const row = await req<Row>("/events", "POST", {
        title: input.title,
        date: input.date,
        time: input.time ?? null,
        start_hour: input.start ?? 0,
        end_hour: input.end ?? 0,
        member_ids: input.memberIds ?? [],
        calendar_id: input.calendarId || null,
        location: input.location ?? null,
      })
      return toEvent(row)
    },
    async updateEvent(id: string, patch: Partial<Omit<CalendarEvent, "id">>) {
      const body: Row = {}
      if (patch.title !== undefined) body.title = patch.title
      if (patch.date !== undefined) body.date = patch.date
      if (patch.time !== undefined) body.time = patch.time ?? null
      if (patch.start !== undefined) body.start_hour = patch.start
      if (patch.end !== undefined) body.end_hour = patch.end
      if (patch.memberIds !== undefined) body.member_ids = patch.memberIds
      if (patch.calendarId !== undefined) body.calendar_id = patch.calendarId || null
      if (patch.location !== undefined) body.location = patch.location ?? null
      const row = await req<Row>(`/events/${id}`, "PATCH", body)
      return toEvent(row)
    },
    async deleteEvent(id: string) {
      await req(`/events/${id}`, "DELETE")
    },

    // ----- chores -----
    async listChores() {
      const rows = await req<Row[]>("/chores", "GET")
      return rows.map(toChore)
    },
    async createChore(input: Omit<Chore, "id">) {
      const row = await req<Row>("/chores", "POST", {
        title: input.title,
        member_id: input.memberId || null,
        done: input.done ?? false,
        points: input.points ?? 0,
        due: input.due ?? null,
      })
      return toChore(row)
    },
    async updateChore(id: string, patch: Partial<Omit<Chore, "id">>) {
      const body: Row = {}
      if (patch.title !== undefined) body.title = patch.title
      if (patch.memberId !== undefined) body.member_id = patch.memberId || null
      if (patch.done !== undefined) body.done = patch.done
      if (patch.points !== undefined) body.points = patch.points
      if (patch.due !== undefined) body.due = patch.due ?? null
      const row = await req<Row>(`/chores/${id}`, "PATCH", body)
      return toChore(row)
    },
    async deleteChore(id: string) {
      await req(`/chores/${id}`, "DELETE")
    },

    // ----- lists -----
    async listLists() {
      const rows = await req<Row[]>("/lists", "GET")
      return rows.map(toChecklist)
    },
    async createList(input: { title: string; color: MemberColor }) {
      const row = await req<Row>("/lists", "POST", { title: input.title, color: input.color })
      return toChecklist(row)
    },
    async updateList(id: string, patch: { title?: string; color?: MemberColor }) {
      const row = await req<Row>(`/lists/${id}`, "PATCH", patch)
      return toChecklist(row)
    },
    async deleteList(id: string) {
      await req(`/lists/${id}`, "DELETE")
    },
    async addListItem(listId: string, label: string) {
      const row = await req<Row>(`/lists/${listId}/items`, "POST", { label })
      return toChecklist(row)
    },
    async updateListItem(listId: string, itemId: string, patch: { label?: string; done?: boolean }) {
      const row = await req<Row>(`/lists/${listId}/items/${itemId}`, "PATCH", patch)
      return toChecklist(row)
    },
    async deleteListItem(listId: string, itemId: string) {
      const row = await req<Row>(`/lists/${listId}/items/${itemId}`, "DELETE")
      return toChecklist(row)
    },

    // ----- meals -----
    async listMeals() {
      const rows = await req<Row[]>("/meals", "GET")
      return rows.map(toMeal)
    },
    async createMeal(input: Omit<Meal, "id">) {
      const row = await req<Row>("/meals", "POST", {
        day: input.day,
        type: input.type,
        name: input.name,
        image: input.image ?? null,
        member_id: input.memberId || null,
      })
      return toMeal(row)
    },
    async updateMeal(id: string, patch: Partial<Omit<Meal, "id">>) {
      const body: Row = {}
      if (patch.day !== undefined) body.day = patch.day
      if (patch.type !== undefined) body.type = patch.type
      if (patch.name !== undefined) body.name = patch.name
      if (patch.image !== undefined) body.image = patch.image ?? null
      if (patch.memberId !== undefined) body.member_id = patch.memberId || null
      const row = await req<Row>(`/meals/${id}`, "PATCH", body)
      return toMeal(row)
    },
    async deleteMeal(id: string) {
      await req(`/meals/${id}`, "DELETE")
    },

    // ----- notifications -----
    async listNotifications() {
      const rows = await req<Row[]>("/notifications", "GET")
      return rows.map(toNotification)
    },
    async createNotification(input: Omit<Notification, "id">) {
      const row = await req<Row>("/notifications", "POST", {
        title: input.title,
        body: input.body ?? null,
        time: input.time ?? null,
        member_id: input.memberId || null,
      })
      return toNotification(row)
    },
    async updateNotification(id: string, patch: Partial<Omit<Notification, "id">>) {
      const body: Row = {}
      if (patch.title !== undefined) body.title = patch.title
      if (patch.body !== undefined) body.body = patch.body ?? null
      if (patch.time !== undefined) body.time = patch.time ?? null
      if (patch.memberId !== undefined) body.member_id = patch.memberId || null
      if (patch.read !== undefined) body.read = patch.read
      const row = await req<Row>(`/notifications/${id}`, "PATCH", body)
      return toNotification(row)
    },
    async deleteNotification(id: string) {
      await req(`/notifications/${id}`, "DELETE")
    },
    async markAllNotificationsRead() {
      await req("/notifications/read-all", "POST")
    },
    async clearNotifications() {
      await req("/notifications", "DELETE")
    },

    // ----- photos -----
    async listPhotos() {
      const rows = await req<Row[]>("/photos", "GET")
      return rows.map(toPhoto)
    },
    async createPhoto(input: Omit<Photo, "id">) {
      // src may already be a full URL if the caller uploaded via multipart elsewhere;
      // otherwise send as body for the server to record as a URL entry.
      const row = await req<Row>("/photos", "POST", {
        src: input.src,
        caption: input.caption ?? "",
      })
      return toPhoto(row)
    },
    async uploadPhoto(file: File, caption = "") {
      // Multipart POST — the server writes the file to $HOME/.lumora/photos/
      // and returns the photo row with a /photo-files/<filename> src URL.
      const token = tokenStore.get()
      const form = new FormData()
      form.append("file", file)
      form.append("caption", caption || file.name.replace(/\.[^.]+$/, ""))
      const res = await fetch(`${LOCAL_API_BASE}/api/v1/photos`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(body.error ?? `Upload failed (${res.status})`)
      }
      return toPhoto(await res.json() as Row)
    },
    async deletePhoto(id: string) {
      await req(`/photos/${id}`, "DELETE")
    },
  }
}
