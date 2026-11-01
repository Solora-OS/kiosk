"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import {
  type Calendar,
  type CalendarEvent,
  type Checklist,
  type Chore,
  type Meal,
  type Member,
  type MemberColor,
  type Notification,
  type PermissionArea,
  type Photo,
  memberCan,
  choreDone,
  choreSchedule,
  eventRangeLabel,
  toISODate,
} from "./data"
import { api, syncGuard, type ApiMember, type CreateMemberInput, type Invite } from "./api"
import { tokenStore } from "./local-api"
import { centralSocket } from "./central-socket"
import { getLocalDeviceId } from "./kiosk-session"
import { useOptionalAuth } from "./auth"
import { notify } from "./push"
import { type KioskDeviceStatus } from "./kiosk-status"
import { fetchKioskSnapshot } from "./kiosk-data"
import { loadHouseholdSeasons } from "./local-api"
import { getDisplayPrefs } from "./display-prefs"

export type TabKey = "home" | "calendar" | "chores" | "rewards" | "lists" | "meals" | "photos" | "settings"

export type SearchResult = {
  key: string
  id: string
  category: "Event" | "Chore" | "List" | "Meal"
  title: string
  detail: string
  memberId: string
  tab: TabKey
}

export type HighlightTarget = { tab: TabKey; id: string; nonce: number } | null

let counter = 1000
function uid(prefix: string) {
  counter += 1
  return `${prefix}${counter}`
}

/** Derive a Member (with display `initial`) from the API shape. */
function toMember(m: ApiMember): Member {
  return {
    id: m.id,
    name: m.name,
    initial: m.name.trim().charAt(0).toUpperCase() || "?",
    color: m.color,
    role: m.role,
    dob: m.dob,
    userId: m.userId,
    account: m.account,
    permissions: m.permissions,
    pending: m.pending,
  }
}

const FALLBACK_MEMBER: Member = { id: "", name: "Unknown", initial: "?", color: "blue", role: "adult" }

const byStart = (a: CalendarEvent, b: CalendarEvent) => a.start - b.start

/**
 * Optimistic CRUD helper for a flat collection. Updates local state
 * immediately for snappy UX, then persists through the API and reconciles
 * (or rolls back) when the request settles.
 */
function makeOptimistic<T extends { id: string }>(
  setItems: Dispatch<SetStateAction<T[]>>,
  ops: {
    create: (input: Omit<T, "id">) => Promise<T>
    update: (id: string, patch: Partial<T>) => Promise<T>
    remove: (id: string) => Promise<void>
    sort?: (a: T, b: T) => number
  },
) {
  const order = (arr: T[]) => (ops.sort ? [...arr].sort(ops.sort) : arr)
  return {
    add(input: Omit<T, "id">) {
      const tmpId = uid("tmp")
      setItems((prev) => order([...prev, { ...input, id: tmpId } as T]))
      ops
        .create(input)
        .then((real) => setItems((prev) => order(prev.map((x) => (x.id === tmpId ? real : x)))))
        .catch(() => setItems((prev) => prev.filter((x) => x.id !== tmpId)))
    },
    update(id: string, patch: Partial<T>) {
      setItems((prev) => order(prev.map((x) => (x.id === id ? { ...x, ...patch } : x))))
      ops
        .update(id, patch)
        .then((real) => setItems((prev) => order(prev.map((x) => (x.id === id ? real : x)))))
        .catch(() => {})
    },
    remove(id: string) {
      setItems((prev) => prev.filter((x) => x.id !== id))
      ops.remove(id).catch(() => {})
    },
  }
}

// Optimistic temp ids look like "tmp1001" / "mem1001" / "cal1001"; real
// server ids are UUIDs. Used to keep not-yet-persisted local rows during a sync.
const TEMP_ID = /^(tmp|mem|cal)\d+$/

/**
 * Merge a freshly-fetched server collection into local state. The server is the
 * source of truth, but we keep any local rows that are still mid-flight (temp
 * ids the server hasn't acknowledged yet) so live polling never makes an
 * optimistic create flicker out.
 */
function reconcile<T extends { id: string }>(prev: T[], incoming: T[], sort?: (a: T, b: T) => number): T[] {
  const serverIds = new Set(incoming.map((i) => i.id))
  const pendingLocal = prev.filter((p) => !serverIds.has(p.id) && TEMP_ID.test(p.id))
  const merged = [...incoming, ...pendingLocal]
  return sort ? merged.sort(sort) : merged
}

type Store = {
  // navigation
  tab: TabKey
  setTab: (t: TabKey) => void
  activeMember: string | null
  setActiveMember: (id: string | null) => void
  highlight: HighlightTarget
  navigateToResult: (r: SearchResult) => void
  clearHighlight: () => void

  // load state
  loading: boolean

  // data
  members: Member[]
  calendars: Calendar[]
  events: CalendarEvent[]
  chores: Chore[]
  lists: Checklist[]
  meals: Meal[]
  notifications: Notification[]
  photos: Photo[]
  kioskDevices: KioskDeviceStatus[]

  // members
  getMember: (id: string) => Member
  /** The member linked to the signed-in account, if any. */
  currentMember: Member | null
  /** True when the signed-in user is an admin of the household. */
  isAdmin: boolean
  /** Whether the signed-in member can manage a given area. */
  can: (area: PermissionArea) => boolean
  addMember: (m: Omit<Member, "id" | "initial">) => void
  updateMember: (id: string, patch: Partial<Omit<Member, "id">>) => void
  deleteMember: (id: string) => void
  /** Create (or refresh) an invite for a member and keep the member list in sync. */
  inviteMember: (member: Member) => Promise<Invite>
  /** Revoke an outstanding invite by invite id, clears the pending flag. */
  cancelInvite: (inviteId: string, memberId: string) => Promise<void>

  // calendars
  addCalendar: (c: Omit<Calendar, "id">) => void
  updateCalendar: (id: string, patch: Partial<Omit<Calendar, "id">>) => void
  deleteCalendar: (id: string) => void

  // events
  addEvent: (e: Omit<CalendarEvent, "id">) => void
  updateEvent: (id: string, patch: Partial<CalendarEvent>) => void
  deleteEvent: (id: string) => void

  // chores
  addChore: (c: Omit<Chore, "id">) => void
  updateChore: (id: string, patch: Partial<Chore>) => void
  deleteChore: (id: string) => void
  toggleChore: (id: string) => void

  // lists
  addList: (title: string, color: MemberColor) => void
  updateList: (id: string, patch: Partial<Omit<Checklist, "items">>) => void
  deleteList: (id: string) => void
  addItem: (listId: string, label: string) => void
  updateItem: (listId: string, itemId: string, label: string) => void
  deleteItem: (listId: string, itemId: string) => void
  /** Remove every ticked item from a list. */
  clearDone: (listId: string) => void
  toggleItem: (listId: string, itemId: string) => void

  // meals
  addMeal: (m: Omit<Meal, "id">) => void
  updateMeal: (id: string, patch: Partial<Meal>) => void
  deleteMeal: (id: string) => void

  // notifications
  unreadCount: number
  addNotification: (n: Omit<Notification, "id">) => void
  toggleNotificationRead: (id: string) => void
  deleteNotification: (id: string) => void
  markAllNotificationsRead: () => void
  clearNotifications: () => void

  // photos
  addPhoto: (p: Omit<Photo, "id">) => void
  deletePhoto: (id: string) => void

  search: (query: string) => SearchResult[]
}

const StoreContext = createContext<Store | null>(null)

export function StoreProvider({ children, kioskMode = false }: { children: ReactNode; kioskMode?: boolean }) {
  const auth = useOptionalAuth()
  const user = auth?.user ?? null
  const [tab, setTab] = useState<TabKey>(() => getDisplayPrefs().startTab)
  const [activeMember, setActiveMember] = useState<string | null>(null)
  const [highlight, setHighlight] = useState<HighlightTarget>(null)

  const [loading, setLoading] = useState(true)
  const [members, setMembers] = useState<Member[]>([])
  const [calendars, setCalendars] = useState<Calendar[]>([])
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [chores, setChores] = useState<Chore[]>([])
  const [lists, setLists] = useState<Checklist[]>([])
  const [meals, setMeals] = useState<Meal[]>([])
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [kioskDevices, setKioskDevices] = useState<KioskDeviceStatus[]>([])

  // Latest-value refs for toggle handlers (avoid stale closures / side effects in updaters).
  const eventsRef = useRef(events)
  const choresRef = useRef(chores)
  const listsRef = useRef(lists)
  const notificationsRef = useRef(notifications)
  useEffect(() => {
    eventsRef.current = events
  }, [events])
  useEffect(() => {
    choresRef.current = chores
  }, [chores])
  useEffect(() => {
    listsRef.current = lists
  }, [lists])
  useEffect(() => {
    notificationsRef.current = notifications
  }, [notifications])

  // Tracks notification ids already seen, so live-sync only fires an OS push
  // for notifications that arrive *after* the first load (not the backlog).
  const seenNotifIds = useRef<Set<string> | null>(null)

  // In kiosk mode, track whether the device token has been bridged into
  // tokenStore. We subscribe to tokenStore changes so the main useEffect
  // re-runs the moment doRegister() calls tokenStore.set() — ensuring
  // loadAll() fires with a valid Bearer token even if it first ran before
  // registration completed.
  const [tokenReady, setTokenReady] = useState(() => !!tokenStore.get())
  useEffect(() => {
    if (!kioskMode) return
    if (tokenStore.get()) { setTokenReady(true); return }
    const unsub = tokenStore.subscribe(() => { setTokenReady(true) })
    return unsub
  }, [kioskMode])

  // Initial live load + Socket.IO live events.
  // On mount we fetch the full household snapshot (or the kiosk snapshot in
  // kiosk mode). After that, Socket.IO events from the local server trigger
  // targeted state updates — we re-fetch only the affected table on each
  // "<table>:<action>" event, coalescing rapid bursts with a 400 ms debounce.
  // A window focus / visibility-change refresh catches anything missed while
  // the socket was disconnected.
  useEffect(() => {
    let alive = true

    // ---- initial load -------------------------------------------------------

    // In kiosk mode, don't attempt to load data until the device token has
    // been registered and bridged into tokenStore. Without a token every
    // request returns empty collections.
    if (kioskMode && !tokenReady) return

    const loadAll = async () => {
      // Kiosk mode: device has no user session — fetch via device-token snapshot.
      if (kioskMode) {
        const snap = await fetchKioskSnapshot()
        return {
          members: snap.members,
          calendars: snap.calendars,
          events: snap.events,
          chores: snap.chores,
          lists: snap.lists,
          meals: snap.meals,
          notifications: snap.notifications,
          photos: snap.photos,
          kioskDevices: [] as KioskDeviceStatus[],
        }
      }

      void loadHouseholdSeasons()
      const [m, cals, e, c, l, me, n, p] = await Promise.all([
        api.listMembers(),
        api.listCalendars(),
        api.listEvents(),
        api.listChores(),
        api.listLists(),
        api.listMeals(),
        api.listNotifications(),
        api.listPhotos(),
      ])

      return {
        members: m.map(toMember),
        calendars: cals,
        events: e,
        chores: c,
        lists: l,
        meals: me,
        notifications: n,
        photos: p,
        kioskDevices: [] as KioskDeviceStatus[],
      }
    }

    type Loaded = Awaited<ReturnType<typeof loadAll>>

    const apply = (d: Loaded, initial: boolean) => {
      if (initial) {
        setMembers(d.members)
        setCalendars(d.calendars)
        setEvents([...d.events].sort(byStart))
        setChores(d.chores)
        setLists(d.lists)
        setMeals(d.meals)
        setNotifications(d.notifications)
        setPhotos(d.photos)
        setKioskDevices(d.kioskDevices)
        seenNotifIds.current = new Set(d.notifications.map((n) => n.id))
        return
      }
      setMembers((prev) => reconcile(prev, d.members))
      setCalendars((prev) => reconcile(prev, d.calendars))
      setEvents((prev) => reconcile(prev, d.events, byStart))
      setChores((prev) => reconcile(prev, d.chores))
      setLists((prev) => reconcile(prev, d.lists))
      setMeals((prev) => reconcile(prev, d.meals))
      setNotifications((prev) => reconcile(prev, d.notifications))
      setPhotos((prev) => reconcile(prev, d.photos))
      setKioskDevices((prev) => reconcile(prev, d.kioskDevices))

      // Surface an OS push for notifications that arrived after initial load.
      const seen = seenNotifIds.current ?? new Set<string>()
      const fresh = d.notifications.filter((n) => !n.read && !seen.has(n.id))
      for (const note of fresh) void notify(note.title, note.body || "")
      const next = new Set(seen)
      for (const n of d.notifications) next.add(n.id)
      seenNotifIds.current = next
    }

    loadAll()
      .then((d) => { if (alive) apply(d, true) })
      .catch(() => { /* leave collections empty on failure */ })
      .finally(() => { if (alive) setLoading(false) })

    // ---- live sync via Socket.IO -------------------------------------------

    const tick = async () => {
      if (!alive) return
      // Skip if a local mutation is still mid-flight — avoids echoing our own write.
      if (syncGuard.isBusy()) { scheduleSync(); return }
      try {
        const d = await loadAll()
        if (alive) apply(d, false)
      } catch {
        /* transient; next event retries */
      }
    }

    let debounce: ReturnType<typeof setTimeout> | undefined
    function scheduleSync() {
      if (!alive) return
      clearTimeout(debounce)
      debounce = setTimeout(() => void tick(), 400)
    }

    // Subscribe to table:action events from the central socket relay.
    // The hub broadcaster emits hub:relay for every DB write, which the central
    // socket server relays to all devices in the hub room.
    // Each event triggers a full re-fetch + reconcile of all collections.
    const unsubscribe = centralSocket.onTableChange(() => {
      scheduleSync()
    })

    // Ensure the kiosk has a central token so it can stay connected.
    // In kiosk mode the device id is available from the kiosk_devices table;
    // we use it to fetch the central JWT from the local hub's API.
    if (kioskMode) {
      const localDeviceId = getLocalDeviceId()
      if (localDeviceId && !centralSocket.connected) {
        void centralSocket.fetchAndStoreCentralToken(localDeviceId).then((token) => {
          if (token) centralSocket.connect(token)
        })
      }
    }

    // Focus / visibility refresh to catch events missed while backgrounded.
    const onFocus = () => scheduleSync()
    const onVisible = () => { if (!document.hidden) scheduleSync() }
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisible)

    return () => {
      alive = false
      clearTimeout(debounce)
      unsubscribe()
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisible)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kioskMode, auth?.household?.id, tokenReady])

  const clearHighlight = useCallback(() => setHighlight(null), [])

  const navigateToResult = useCallback((r: SearchResult) => {
    setActiveMember(null)
    setTab(r.tab)
    setHighlight({ tab: r.tab, id: r.id, nonce: Date.now() })
  }, [])

  // ----- members -----------------------------------------------------------
  const getMember = useCallback(
    (id: string): Member => members.find((m) => m.id === id) ?? FALLBACK_MEMBER,
    [members],
  )
  const addMember = useCallback((m: Omit<Member, "id" | "initial">) => {
    const input: CreateMemberInput = {
      name: m.name,
      color: m.color,
      role: m.role,
      dob: m.dob,
      account: m.account,
      permissions: m.permissions,
    }
    const tmpId = uid("mem")
    setMembers((prev) => [...prev, { ...m, id: tmpId, initial: m.name.trim().charAt(0).toUpperCase() || "?" }])
    api
      .createMember(input)
      .then((real) => setMembers((prev) => prev.map((x) => (x.id === tmpId ? toMember(real) : x))))
      .catch(() => setMembers((prev) => prev.filter((x) => x.id !== tmpId)))
  }, [])
  const updateMember = useCallback((id: string, patch: Partial<Omit<Member, "id">>) => {
    const { initial: _initial, ...rest } = patch
    const apiPatch = rest as Partial<CreateMemberInput>
    setMembers((prev) =>
      prev.map((m) => {
        if (m.id !== id) return m
        const merged = { ...m, ...patch }
        if (patch.name) merged.initial = patch.name.trim().charAt(0).toUpperCase() || m.initial
        return merged
      }),
    )
    api
      .updateMember(id, apiPatch)
      .then((real) => setMembers((prev) => prev.map((m) => (m.id === id ? toMember(real) : m))))
      .catch(() => {})
  }, [])
  const deleteMember = useCallback((id: string) => {
    setMembers((prev) => prev.filter((m) => m.id !== id))
    api.deleteMember(id).catch(() => {})
  }, [])
  const inviteMember = useCallback(async (member: Member): Promise<Invite> => {
    const invite = await api.createInvite({
      memberId: member.id,
      name: member.name,
      role: member.role,
      color: member.color,
      dob: member.dob,
      email: member.account,
    })
    // Mark the existing member as pending rather than doing a full re-sync.
    // A full listMembers() re-sync causes the server's newly-created pending
    // slot to appear alongside the original member, duplicating the row.
    setMembers((prev) =>
      prev.map((m) => (m.id === member.id ? { ...m, pending: true } : m)),
    )
    return invite
  }, [])
  const cancelInvite = useCallback(async (inviteId: string, memberId: string) => {
    await api.deleteInvite(inviteId)
    // Clear pending flag optimistically.
    setMembers((prev) =>
      prev.map((m) => (m.id === memberId ? { ...m, pending: false } : m)),
    )
  }, [])

  // The member tied to the signed-in account drives role-based permissions.
  // Match on the auth user id first (Supabase links members via user_id), then
  // fall back to the account email for adapters that only set that.
  const currentMember = useMemo(() => {
    if (!user) return null
    const byUserId = members.find((m) => m.userId && m.userId === user.id)
    if (byUserId) return byUserId
    if (!user.email) return null
    const email = user.email.toLowerCase()
    return members.find((m) => m.account?.toLowerCase() === email) ?? null
  }, [members, user])
  const isAdmin = kioskMode ? true : currentMember?.role === "admin"
  const can = useCallback(
    (area: PermissionArea) => {
      // Kiosk is a claimed, permission-granted display — allow all operations.
      if (kioskMode) return true
      return memberCan(currentMember, area)
    },
    [kioskMode, currentMember],
  )

  // ----- calendars ---------------------------------------------------------
  const addCalendar = useCallback((c: Omit<Calendar, "id">) => {
    const tmpId = uid("cal")
    setCalendars((prev) => [...prev, { ...c, id: tmpId }])
    api
      .createCalendar(c)
      .then((real) => setCalendars((prev) => prev.map((x) => (x.id === tmpId ? real : x))))
      .catch(() => setCalendars((prev) => prev.filter((x) => x.id !== tmpId)))
  }, [])
  const updateCalendar = useCallback((id: string, patch: Partial<Omit<Calendar, "id">>) => {
    setCalendars((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
    api.updateCalendar(id, patch).catch(() => {})
  }, [])
  const deleteCalendar = useCallback((id: string) => {
    // Collect event ids to remove before wiping local state.
    const eventsToDelete = eventsRef.current.filter((e) => e.calendarId === id).map((e) => e.id)
    setCalendars((prev) => prev.filter((c) => c.id !== id))
    // Drop events that belonged to the removed calendar locally.
    setEvents((prev) => prev.filter((e) => e.calendarId !== id))
    api.deleteCalendar(id).catch(() => {})
    // Also explicitly delete each related event via the API in case the server
    // doesn't cascade on its own — fire-and-forget, errors are benign.
    for (const evId of eventsToDelete) {
      api.deleteEvent(evId).catch(() => {})
    }
  }, [])

  // ----- events / chores / meals (flat collections) ------------------------
  const eventCrud = useMemo(
    () =>
      makeOptimistic<CalendarEvent>(setEvents, {
        create: api.createEvent,
        update: api.updateEvent,
        remove: api.deleteEvent,
        sort: byStart,
      }),
    [],
  )
  const choreCrud = useMemo(
    () => makeOptimistic<Chore>(setChores, { create: api.createChore, update: api.updateChore, remove: api.deleteChore }),
    [],
  )
  const mealCrud = useMemo(
    () => makeOptimistic<Meal>(setMeals, { create: api.createMeal, update: api.updateMeal, remove: api.deleteMeal }),
    [],
  )

  const toggleChore = useCallback((id: string) => {
    const c = choresRef.current.find((x) => x.id === id)
    if (!c) return
    const done = !choreDone(c, toISODate(new Date()))
    const doneOn = done ? toISODate(new Date()) : undefined
    setChores((prev) => prev.map((x) => (x.id === id ? { ...x, done, doneOn } : x)))
    api.updateChore(id, { done }).catch(() => {})
  }, [])

  // ----- lists -------------------------------------------------------------
  const replaceList = useCallback((updated: Checklist) =>
    setLists((prev) => prev.map((l) => (l.id === updated.id ? updated : l))), [])

  const addList = useCallback((title: string, color: MemberColor) => {
    const tmpId = uid("lst")
    setLists((prev) => [...prev, { id: tmpId, title, color, items: [] }])
    api
      .createList({ title, color })
      .then((real) => setLists((prev) => prev.map((l) => (l.id === tmpId ? real : l))))
      .catch(() => setLists((prev) => prev.filter((l) => l.id !== tmpId)))
  }, [])
  const updateList = useCallback((id: string, patch: Partial<Omit<Checklist, "items">>) => {
    setLists((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    api.updateList(id, patch).then(replaceList).catch(() => {})
  }, [])
  const deleteList = useCallback((id: string) => {
    setLists((prev) => prev.filter((l) => l.id !== id))
    api.deleteList(id).catch(() => {})
  }, [])
  const addItem = useCallback((listId: string, label: string) => {
    const tmpId = uid("itm")
    setLists((prev) =>
      prev.map((l) => (l.id === listId ? { ...l, items: [...l.items, { id: tmpId, label, done: false }] } : l)),
    )
    api.addListItem(listId, label).then(replaceList).catch(() => {})
  }, [replaceList])
  const updateItem = useCallback((listId: string, itemId: string, label: string) => {
    setLists((prev) =>
      prev.map((l) =>
        l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, label } : i)) } : l,
      ),
    )
    api.updateListItem(listId, itemId, { label }).then(replaceList).catch(() => {})
  }, [replaceList])
  const deleteItem = useCallback((listId: string, itemId: string) => {
    setLists((prev) =>
      prev.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => i.id !== itemId) } : l)),
    )
    api.deleteListItem(listId, itemId).then(replaceList).catch(() => {})
  }, [replaceList])
  const clearDone = useCallback((listId: string) => {
    setLists((prev) => prev.map((l) => (l.id === listId ? { ...l, items: l.items.filter((i) => !i.done) } : l)))
    api.clearDoneItems(listId).then(replaceList).catch(() => {})
  }, [replaceList])
  const toggleItem = useCallback((listId: string, itemId: string) => {
    const list = listsRef.current.find((l) => l.id === listId)
    const item = list?.items.find((i) => i.id === itemId)
    if (!item) return
    const done = !item.done
    setLists((prev) =>
      prev.map((l) =>
        l.id === listId ? { ...l, items: l.items.map((i) => (i.id === itemId ? { ...i, done } : i)) } : l,
      ),
    )
    api.updateListItem(listId, itemId, { done }).then(replaceList).catch(() => {})
  }, [replaceList])

  // ----- notifications -----------------------------------------------------
  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications])
  const addNotification = useCallback((n: Omit<Notification, "id">) => {
    const tmpId = uid("ntf")
    setNotifications((prev) => [{ ...n, id: tmpId }, ...prev])
    api
      .createNotification(n)
      .then((real) => setNotifications((prev) => prev.map((x) => (x.id === tmpId ? real : x))))
      .catch(() => setNotifications((prev) => prev.filter((x) => x.id !== tmpId)))
  }, [])
  const toggleNotificationRead = useCallback((id: string) => {
    const n = notificationsRef.current.find((x) => x.id === id)
    if (!n) return
    const read = !n.read
    setNotifications((prev) => prev.map((x) => (x.id === id ? { ...x, read } : x)))
    api.updateNotification(id, { read }).catch(() => {})
  }, [])
  const deleteNotification = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id))
    api.deleteNotification(id).catch(() => {})
  }, [])
  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
    api.markAllNotificationsRead().catch(() => {})
  }, [])
  const clearNotifications = useCallback(() => {
    setNotifications([])
    api.clearNotifications().catch(() => {})
  }, [])

  // ----- photos ---------------------------------------------------------------
  const addPhoto = useCallback((p: Omit<Photo, "id">) => {
    const tmpId = uid("pho")
    setPhotos((prev) => [{ ...p, id: tmpId }, ...prev])
    api
      .createPhoto(p)
      .then((real) => setPhotos((prev) => prev.map((x) => (x.id === tmpId ? real : x))))
      .catch(() => setPhotos((prev) => prev.filter((x) => x.id !== tmpId)))
  }, [])
  const deletePhoto = useCallback((id: string) => {
    setPhotos((prev) => prev.filter((p) => p.id !== id))
    api.deletePhoto(id).catch(() => {})
  }, [])

  const search = useCallback(
    (query: string): SearchResult[] => {
      const q = query.trim().toLowerCase()
      if (!q) return []
      const out: SearchResult[] = []
      for (const e of events) {
        if (e.title.toLowerCase().includes(q) || (e.location ?? "").toLowerCase().includes(q)) {
          out.push({
            key: `Event-${e.id}`,
            id: e.id,
            category: "Event",
            title: e.title,
            detail: `${eventRangeLabel(e)}${e.location ? ` · ${e.location}` : ""}`,
            memberId: e.memberIds[0] ?? "",
            tab: "calendar",
          })
        }
      }
      for (const c of chores) {
        if (c.title.toLowerCase().includes(q)) {
          out.push({
            key: `Chore-${c.id}`,
            id: c.id,
            category: "Chore",
            title: c.title,
            detail: `${choreSchedule(c)} · ${c.points} pts`,
            memberId: c.memberId,
            tab: "chores",
          })
        }
      }
      for (const l of lists) {
        for (const i of l.items) {
          if (i.label.toLowerCase().includes(q)) {
            out.push({
              key: `List-${i.id}`,
              id: l.id,
              category: "List",
              title: i.label,
              detail: l.title,
              memberId: "family",
              tab: "lists",
            })
          }
        }
      }
      for (const m of meals) {
        if (m.name.toLowerCase().includes(q)) {
          out.push({
            key: `Meal-${m.id}`,
            id: m.id,
            category: "Meal",
            title: m.name,
            detail: `${m.day} · ${m.type}`,
            memberId: m.memberId,
            tab: "meals",
          })
        }
      }
      return out
    },
    [events, chores, lists, meals],
  )

  const value = useMemo<Store>(
    () => ({
      tab,
      setTab,
      activeMember,
      setActiveMember,
      highlight,
      navigateToResult,
      clearHighlight,
      loading,
      members,
      calendars,
      events,
      chores,
      lists,
      meals,
      notifications,
      photos,
      kioskDevices,
      getMember,
      currentMember,
      isAdmin,
      can,
      addMember,
      updateMember,
      deleteMember,
      inviteMember,
      cancelInvite,
      addCalendar,
      updateCalendar,
      deleteCalendar,
      addEvent: eventCrud.add,
      updateEvent: eventCrud.update,
      deleteEvent: eventCrud.remove,
      addChore: choreCrud.add,
      updateChore: choreCrud.update,
      deleteChore: choreCrud.remove,
      toggleChore,
      addList,
      updateList,
      deleteList,
      addItem,
      updateItem,
      deleteItem,
      clearDone,
      toggleItem,
      addMeal: mealCrud.add,
      updateMeal: mealCrud.update,
      deleteMeal: mealCrud.remove,
      unreadCount,
      addNotification,
      toggleNotificationRead,
      deleteNotification,
      markAllNotificationsRead,
      clearNotifications,
      addPhoto,
      deletePhoto,
      search,
    }),
    [
      tab,
      activeMember,
      highlight,
      navigateToResult,
      clearHighlight,
      loading,
      members,
      calendars,
      events,
      chores,
      lists,
      meals,
      notifications,
      photos,
      kioskDevices,
      getMember,
      currentMember,
      isAdmin,
      can,
      addMember,
      updateMember,
      deleteMember,
      inviteMember,
      cancelInvite,
      addCalendar,
      updateCalendar,
      deleteCalendar,
      eventCrud,
      choreCrud,
      mealCrud,
      toggleChore,
      addList,
      updateList,
      deleteList,
      addItem,
      updateItem,
      deleteItem,
      clearDone,
      toggleItem,
      unreadCount,
      addNotification,
      toggleNotificationRead,
      deleteNotification,
      markAllNotificationsRead,
      clearNotifications,
      addPhoto,
      deletePhoto,
      search,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error("useStore must be used within StoreProvider")
  return ctx
}

/** Scroll-and-highlight hook for views. Returns a ref callback to register a row by id. */
export function useHighlight(tab: TabKey) {
  const { highlight, clearHighlight } = useStore()
  const refs = useState(() => new Map<string, HTMLElement>())[0]

  const register = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) refs.set(id, el)
      else refs.delete(id)
    },
    [refs],
  )

  return { highlight: highlight && highlight.tab === tab ? highlight : null, refs, register, clearHighlight }
}
