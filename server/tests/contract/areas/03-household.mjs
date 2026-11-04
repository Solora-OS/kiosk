// Chapter 3 — a week of family life: calendars and events, chores, points
// and rewards, lists, meals, notifications, the home screen, away and summer
// breaks, seasons, phones at the wall, wall commands, the snapshot and the
// activity log. Who may do what: Maya (admin), Daniel (calendar, chores,
// lists, meals), Sofia (teen) and Leo (child), the wall, an unpaired display.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ctx, hub, broadcasts, snapshot, sortedBy, sortList } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)
const as = (who) => ({ maya: ctx.mayaAccount, daniel: ctx.danielAccount, sofia: ctx.sofia.token, leo: ctx.leo.token, wall: ctx.wallToken, unpaired: ctx.hallToken })[who]
const call = (who, method, path, body) => hub(method, `/api/v1${path}`, { token: as(who), body })
const NOBODY = "00000000-0000-4000-8000-000000000000"

/** Runs a write as Maya's socket sees it; returns the response and the events it caused. */
async function seen(fn) {
  const { result, events } = await broadcasts(ctx.mayaSocket, fn)
  return { r: result, events }
}

test("calendars", async () => {
  const members = (await call("maya", "GET", "/members")).body
  ctx.memberId = Object.fromEntries(members.map((m) => [m.name, m.id]))

  same("03-calendars", await call("maya", "GET", "/calendars"))
  same("03-calendar-add-child", await call("leo", "POST", "/calendars", { name: "Mine" }))
  same("03-calendar-add-no-name", await call("maya", "POST", "/calendars", {}))
  const school = await seen(() => call("daniel", "POST", "/calendars", { name: " School ", color: "green", memberIds: [ctx.memberId.Sofia, ctx.memberId.Leo] }))
  same("03-calendar-add", school.r)
  assert.deepEqual(school.events, ["calendars:created"])
  ctx.schoolCalendar = school.r.body.id

  same("03-calendar-edit-nothing", await call("maya", "PATCH", `/calendars/${ctx.schoolCalendar}`, {}))
  same("03-calendar-edit-unknown", await call("maya", "PATCH", `/calendars/${NOBODY}`, { name: "x" }))
  same("03-calendar-edit-child", await call("leo", "PATCH", `/calendars/${ctx.schoolCalendar}`, { name: "x" }))
  const edited = await seen(() => call("maya", "PATCH", `/calendars/${ctx.schoolCalendar}`, { color: "purple" }))
  same("03-calendar-edit", edited.r)
  assert.deepEqual(edited.events, ["calendars:updated"])

  const extra = await call("maya", "POST", "/calendars", { name: "Work" })
  same("03-calendar-delete-unknown", await call("maya", "DELETE", `/calendars/${NOBODY}`))
  const del = await seen(() => call("maya", "DELETE", `/calendars/${extra.body.id}`))
  assert.equal(del.r.status, 204)
  assert.deepEqual(del.events, ["calendars:deleted"])
})

test("events: who adds, who changes, how times are normalised", async () => {
  same("03-event-missing", await call("maya", "POST", "/events", { title: "x" }))
  same("03-event-bad-date", await call("maya", "POST", "/events", { title: "x", date: "May 4" }))
  same("03-event-unpaired", await call("unpaired", "POST", "/events", { title: "x", date: "2031-05-12" }))

  const trip = await seen(() => call("maya", "POST", "/events", {
    title: "Beach trip", date: "2031-07-02", endDate: "2031-07-06", allDay: true, memberIds: Object.values(ctx.memberId), calendarId: ctx.schoolCalendar, countdown: true,
  }))
  same("03-event-all-day", trip.r)
  assert.deepEqual(trip.events, ["events:created"])

  // The kiosk sends snake_case; an end before the start becomes start + 1h.
  same("03-event-snake-case", await call("wall", "POST", "/events", { title: "Dentist", date: "2031-05-12", start_hour: 15.5, end_hour: 15, location: "Main St", remind_minutes: 30 }))
  const soccer = await call("maya", "POST", "/events", {
    title: "Soccer", date: "2031-05-13", start: 17, end: 18.25, repeatDays: [4, 2, 2, 9], repeatUntil: "2031-08-01", skipDates: ["2031-05-20", "bad", "2031-05-20"], reminderMinutes: 99999,
  })
  same("03-event-repeating", soccer.r ?? soccer)
  ctx.soccerEvent = soccer.body.id

  // Leo adds his own; he can't put others on it.
  const leos = await call("leo", "POST", "/events", { title: "Lego club", date: "2031-05-14", start: 16, end: 17, memberIds: [ctx.memberId.Maya] })
  assert.deepEqual(leos.body.memberIds, [ctx.memberId.Leo])
  same("03-event-by-child", leos)

  same("03-event-edit-not-yours", await call("sofia", "PATCH", `/events/${leos.body.id}`, { title: "x" }))
  same("03-event-edit-own", await call("leo", "PATCH", `/events/${leos.body.id}`, { title: "Lego Club", memberIds: [ctx.memberId.Maya], start: 16.5 }))
  same("03-event-edit-nothing", await call("maya", "PATCH", `/events/${ctx.soccerEvent}`, {}))
  same("03-event-edit-unknown", await call("maya", "PATCH", `/events/${NOBODY}`, { title: "x" }))
  same("03-event-stop-repeating", await call("daniel", "PATCH", `/events/${ctx.soccerEvent}`, { repeatDays: [], allDay: false, end_date: "2031-05-01" }))
  same("03-event-delete-not-yours", await call("sofia", "DELETE", `/events/${leos.body.id}`))
  same("03-event-delete-unknown", await call("maya", "DELETE", `/events/${NOBODY}`))
  const del = await seen(() => call("leo", "DELETE", `/events/${leos.body.id}`))
  assert.equal(del.r.status, 204)
  assert.deepEqual(del.events, ["events:deleted"])

  same("03-events", await call("sofia", "GET", "/events"))
})

test("chores and points", async () => {
  same("03-chore-no-title", await call("maya", "POST", "/chores", {}))
  const dishes = await seen(() => call("maya", "POST", "/chores", { title: "Dishes", memberId: ctx.memberId.Leo, points: 10, repeatDays: [6, 0, 1, 2, 3, 4, 5], icon: "dishes", summerMode: "days", summerDays: [1, 3] }))
  same("03-chore-add", dishes.r)
  assert.deepEqual(dishes.events, ["chores:created"])
  ctx.dishes = dishes.r.body.id
  const room = await call("daniel", "POST", "/chores", { title: "Tidy room", memberId: ctx.memberId.Sofia, points: 5, due: "Saturday", icon: "NOT OK", keepWhileAway: true, summerMode: "nope" })
  same("03-chore-add-normalised", room)
  ctx.room = room.body.id

  same("03-chore-check-others", await call("sofia", "PATCH", `/chores/${ctx.dishes}`, { done: true }))
  const done = await seen(() => call("leo", "PATCH", `/chores/${ctx.dishes}`, { done: true }))
  same("03-chore-check", done.r)
  assert.ok(done.events.includes("chores:updated"))
  await call("leo", "PATCH", `/chores/${ctx.dishes}`, { done: false })
  await call("leo", "PATCH", `/chores/${ctx.dishes}`, { done: true })
  // The wall can check anyone's off.
  same("03-chore-check-wall", await call("wall", "PATCH", `/chores/${ctx.room}`, { done: true }))
  same("03-chore-edit-nothing", await call("maya", "PATCH", `/chores/${ctx.room}`, {}))
  same("03-chore-edit-unknown", await call("maya", "PATCH", `/chores/${NOBODY}`, { title: "x" }))
  same("03-chore-edit", await call("maya", "PATCH", `/chores/${ctx.room}`, { title: "Tidy room!", repeatDays: null, memberId: ctx.memberId.Sofia, summerDays: [] }))

  const gone = await call("maya", "POST", "/chores", { title: "Temporary" })
  same("03-chore-delete-unknown", await call("maya", "DELETE", `/chores/${NOBODY}`))
  assert.equal((await call("maya", "DELETE", `/chores/${gone.body.id}`)).status, 204)
  same("03-chores", sortedBy(await call("leo", "GET", "/chores"), "title"))
})

test("rewards: kids ask, parents decide, points add up", async () => {
  same("03-reward-child", await call("leo", "POST", "/rewards", { title: "x", cost: 1 }))
  same("03-reward-no-title", await call("maya", "POST", "/rewards", { cost: 5 }))
  same("03-reward-bad-cost", await call("maya", "POST", "/rewards", { title: "x", cost: 2.5 }))
  const ice = await call("maya", "POST", "/rewards", { title: "Ice cream", cost: 5, icon: "ice-cream" })
  same("03-reward-add", ice)
  const park = await call("daniel", "POST", "/rewards", { title: "Water park", cost: 500, icon: "BAD" })
  const movie = await call("maya", "POST", "/rewards", { title: "Movie night", cost: 3 })
  same("03-reward-edit-unknown", await call("maya", "PATCH", `/rewards/${NOBODY}`, { cost: 2 }))
  same("03-reward-edit-bad", await call("maya", "PATCH", `/rewards/${movie.body.id}`, { cost: 0 }))
  same("03-reward-edit", await call("maya", "PATCH", `/rewards/${movie.body.id}`, { cost: 4 }))

  same("03-redeem-unknown", await call("leo", "POST", `/rewards/${NOBODY}/redeem`, {}))
  same("03-redeem-for-someone-else", await call("leo", "POST", `/rewards/${ice.body.id}/redeem`, { memberId: ctx.memberId.Sofia }))
  same("03-redeem-too-dear", await call("leo", "POST", `/rewards/${park.body.id}/redeem`, {}))
  const ask = await seen(() => call("leo", "POST", `/rewards/${ice.body.id}/redeem`, {}))
  same("03-redeem-ask", ask.r)
  assert.ok(ask.events.includes("notifications:created"), "parents hear about it")

  same("03-redeem-wall-approves", await call("wall", "POST", `/rewards/redemptions/${ask.r.body.id}/approve`, {}))
  same("03-redeem-approve", await call("maya", "POST", `/rewards/redemptions/${ask.r.body.id}/approve`, {}))
  same("03-redeem-approve-again", await call("maya", "POST", `/rewards/redemptions/${ask.r.body.id}/approve`, {}))
  const second = await call("leo", "POST", `/rewards/${movie.body.id}/redeem`, {})
  same("03-redeem-not-enough-left", await call("leo", "POST", `/rewards/${ice.body.id}/redeem`, {}))
  same("03-redeem-decline", await call("daniel", "POST", `/rewards/redemptions/${second.body.id}/decline`, {}))
  same("03-redeem-by-parent", await call("maya", "POST", `/rewards/${movie.body.id}/redeem`, { memberId: ctx.memberId.Leo }))
  same("03-redeem-parent-unknown-member", await call("maya", "POST", `/rewards/${movie.body.id}/redeem`, { memberId: NOBODY }))

  const shelf = await call("leo", "GET", "/rewards")
  same("03-rewards", { status: shelf.status, body: { ...shelf.body, points: [...shelf.body.points].sort((a, b) => b.balance - a.balance || a.memberId.localeCompare(b.memberId)).map(({ memberId, ...p }) => p), redemptions: sortList(shelf.body.redemptions, "title") } })
  same("03-reward-delete-child", await call("leo", "DELETE", `/rewards/${park.body.id}`))
  assert.equal((await call("maya", "DELETE", `/rewards/${park.body.id}`)).status, 204)
})

test("lists: parents run them, everyone adds and ticks", async () => {
  same("03-list-child", await call("leo", "POST", "/lists", { title: "x" }))
  same("03-list-no-title", await call("maya", "POST", "/lists", {}))
  const groceries = await seen(() => call("daniel", "POST", "/lists", { title: "Groceries", color: "green" }))
  same("03-list-add", groceries.r)
  assert.deepEqual(groceries.events, ["lists:created"])
  const id = groceries.r.body.id
  ctx.groceries = id

  same("03-item-no-label", await call("leo", "POST", `/lists/${id}/items`, {}))
  same("03-item-unknown-list", await call("leo", "POST", `/lists/${NOBODY}/items`, { label: "x" }))
  const milk = await call("maya", "POST", `/lists/${id}/items`, { label: " Milk " })
  const cookies = await seen(() => call("leo", "POST", `/lists/${id}/items`, { label: "Cookies" }))
  same("03-item-add", cookies.r)
  assert.deepEqual(cookies.events, ["lists:updated"])
  const cookieId = cookies.r.body.items.find((i) => i.label === "Cookies").id
  const milkId = milk.body.items.find((i) => i.label === "Milk").id

  same("03-item-relabel-not-yours", await call("sofia", "PATCH", `/lists/${id}/items/${cookieId}`, { label: "Broccoli" }))
  same("03-item-tick-anyones", await call("sofia", "PATCH", `/lists/${id}/items/${milkId}`, { done: true }))
  same("03-item-edit-nothing", await call("leo", "PATCH", `/lists/${id}/items/${cookieId}`, {}))
  same("03-item-edit-unknown", await call("leo", "PATCH", `/lists/${id}/items/${NOBODY}`, { done: true }))
  same("03-item-edit-own", await call("leo", "PATCH", `/lists/${id}/items/${cookieId}`, { label: "Oreos", position: 0 }))
  same("03-item-delete-not-yours", await call("leo", "DELETE", `/lists/${id}/items/${milkId}`))
  same("03-list-clear-done-child", await call("leo", "POST", `/lists/${id}/clear-done`, {}))
  same("03-list-clear-done", await call("maya", "POST", `/lists/${id}/clear-done`, {}))
  same("03-item-delete-own", await call("leo", "DELETE", `/lists/${id}/items/${cookieId}`))

  same("03-list-edit-child", await call("leo", "PATCH", `/lists/${id}`, { title: "x" }))
  same("03-list-edit-nothing", await call("maya", "PATCH", `/lists/${id}`, {}))
  same("03-list-edit-unknown", await call("maya", "PATCH", `/lists/${NOBODY}`, { title: "x" }))
  same("03-list-edit", await call("maya", "PATCH", `/lists/${id}`, { title: "Groceries (Costco)" }))
  await call("maya", "POST", `/lists/${id}/items`, { label: "Eggs" })
  const temp = await call("maya", "POST", "/lists", { title: "Packing" })
  same("03-list-delete-child", await call("leo", "DELETE", `/lists/${temp.body.id}`))
  same("03-list-delete-unknown", await call("maya", "DELETE", `/lists/${NOBODY}`))
  assert.equal((await call("maya", "DELETE", `/lists/${temp.body.id}`)).status, 204)
  same("03-lists", await call("leo", "GET", "/lists"))
})

test("meals", async () => {
  same("03-meal-child", await call("leo", "POST", "/meals", { day: "Mon", name: "Pizza" }))
  same("03-meal-missing", await call("daniel", "POST", "/meals", { name: "Pizza" }))
  const tacos = await seen(() => call("daniel", "POST", "/meals", { date: "2031-05-16", name: "Tacos", ingredients: "tortillas\n\n beans \nsalsa" }))
  same("03-meal-add", tacos.r)
  assert.deepEqual(tacos.events, ["meals:created"])
  same("03-meal-add-by-day", await call("maya", "POST", "/meals", { day: "Sun", name: "Roast", type: "lunch", memberId: ctx.memberId.Daniel, ingredients: ["chicken", "", "potatoes"] }))
  same("03-meal-edit-nothing", await call("maya", "PATCH", `/meals/${tacos.r.body.id}`, {}))
  same("03-meal-edit-unknown", await call("maya", "PATCH", `/meals/${NOBODY}`, { name: "x" }))
  same("03-meal-edit", await call("maya", "PATCH", `/meals/${tacos.r.body.id}`, { date: "2031-05-17", image: "https://example.com/t.jpg", ingredients: ["tortillas"] }))
  const gone = await call("maya", "POST", "/meals", { day: "Tue", name: "Leftovers" })
  same("03-meal-delete-child", await call("leo", "DELETE", `/meals/${gone.body.id}`))
  same("03-meal-delete-unknown", await call("maya", "DELETE", `/meals/${NOBODY}`))
  assert.equal((await call("maya", "DELETE", `/meals/${gone.body.id}`)).status, 204)
  same("03-meals", await call("leo", "GET", "/meals"))
})

test("notifications: per person, read and dismissed per person", async () => {
  same("03-notification-no-title", await call("maya", "POST", "/notifications", {}))
  const note = await seen(() => call("wall", "POST", "/notifications", { title: "Pizza is here", body: "Come down", time: "6:00 PM" }))
  same("03-notification-add", note.r)
  assert.deepEqual(note.events, ["notifications:created"])
  await call("maya", "POST", "/notifications", { title: "Just for Leo", memberId: ctx.memberId.Leo })

  same("03-notifications-maya", sortedBy(await call("maya", "GET", "/notifications"), "title"))
  same("03-notifications-leo", sortedBy(await call("leo", "GET", "/notifications"), "title"))
  same("03-notifications-wall", sortedBy(await call("wall", "GET", "/notifications"), "title"))

  same("03-notification-edit-unknown", await call("maya", "PATCH", `/notifications/${NOBODY}`, { read: true }))
  same("03-notification-read", await call("leo", "PATCH", `/notifications/${note.r.body.id}`, { read: true, title: "Pizza is HERE" }))
  same("03-notification-read-by-other", await call("sofia", "GET", "/notifications").then((r) => ({ status: r.status, body: r.body.find((n) => n.id === note.r.body.id) })))
  same("03-notification-dismiss-unknown", await call("leo", "DELETE", `/notifications/${NOBODY}`))
  assert.equal((await call("leo", "DELETE", `/notifications/${note.r.body.id}`)).status, 204)
  assert.equal((await call("leo", "GET", "/notifications")).body.some((n) => n.id === note.r.body.id), false)
  assert.equal((await call("sofia", "POST", "/notifications/read-all", {})).status, 204)
  assert.ok((await call("sofia", "GET", "/notifications")).body.every((n) => n.read))
  assert.equal((await call("sofia", "DELETE", "/notifications")).status, 204)
  same("03-notifications-cleared", await call("sofia", "GET", "/notifications"))
})

test("home screen, away, summer and seasons", async () => {
  same("03-home-empty", await call("maya", "GET", "/home"))
  same("03-home-bad", await call("leo", "PUT", "/home", { widgets: [{ id: "a b", type: "clock", size: "s" }] }))
  same("03-home-too-big", await call("leo", "PUT", "/home", { widgets: [{ id: "a", type: "note", size: "m", config: { text: "x".repeat(21_000) } }] }))
  same("03-home-set", await call("wall", "PUT", "/home", { widgets: [{ id: "clock", type: "clock", size: "s", extra: 1 }, { id: "cal", type: "calendar", size: "full", config: { days: 3 } }] }))
  same("03-home", await call("sofia", "GET", "/home"))

  same("03-away-none", await call("maya", "GET", "/away"))
  same("03-away-child", await call("leo", "PUT", "/away", { from: "2031-07-02", until: "2031-07-06" }))
  same("03-away-wall", await call("wall", "PUT", "/away", { from: "2031-07-02", until: "2031-07-06" }))
  same("03-away-backwards", await call("maya", "PUT", "/away", { from: "2031-07-06", until: "2031-07-02" }))
  same("03-away-set", await call("maya", "PUT", "/away", { from: "2031-07-02", until: "2031-07-06", label: "  Beach " }))
  same("03-away", await call("leo", "GET", "/away"))
  assert.equal((await call("daniel", "DELETE", "/away")).status, 204)
  same("03-away-ended", await call("leo", "GET", "/away"))

  same("03-summer-none", await call("maya", "GET", "/summer"))
  same("03-summer-child", await call("leo", "PUT", "/summer", { from: "2031-06-10", until: "2031-08-20" }))
  same("03-summer-bad", await call("maya", "PUT", "/summer", { from: "2031-06-10" }))
  const summer = await seen(() => call("wall", "PUT", "/summer", { from: "2031-06-10", until: "2031-08-20" }))
  same("03-summer-set", summer.r)
  assert.deepEqual(summer.events, ["households:updated"])
  same("03-summer", await call("leo", "GET", "/summer"))
  same("03-summer-end-child", await call("leo", "DELETE", "/summer"))
  const ended = await seen(() => call("daniel", "DELETE", "/summer"))
  assert.equal(ended.r.status, 204)
  assert.deepEqual(ended.events, ["households:updated"])
  same("03-summer-ended", await call("leo", "GET", "/summer"))
  await call("wall", "PUT", "/summer", { from: "2031-06-10", until: "2031-08-20" })

  same("03-seasons-default", await call("leo", "GET", "/seasons"))
  same("03-seasons-child", await call("leo", "PUT", "/seasons", { holidays: [] }))
  const theme = (n) => ({ id: `custom-${n}`, name: `Theme ${n}`, accent: { light: "#fff", dark: "#000" }, tint: 400, effect: "snow", ornamentSvg: "<svg/>" })
  same("03-seasons-too-many", await call("maya", "PUT", "/seasons", { themes: Array.from({ length: 13 }, (_, i) => theme(i)) }))
  same("03-seasons-set", await call("maya", "PUT", "/seasons", { holidays: ["diwali", "christmas", "christmas", "made-up"], themes: [theme(1), { id: "x", name: "bad" }, { ...theme(2), effect: "fire", ornamentSvg: "nope" }] }))
  same("03-seasons-holidays-only", await call("wall", "PUT", "/seasons", { holidays: ["easter"] }))
})

test("phones at the wall: presence pass, walking up, throwing", async () => {
  same("03-presence-wall", await call("wall", "POST", "/wall/presence-token", {}))
  const pass = await call("leo", "POST", "/wall/presence-token", {})
  same("03-presence", pass)
  // The pass only works at /near.
  same("03-presence-elsewhere", await hub("GET", "/api/v1/members", { token: pass.body.token }))

  const tag = ctx.wallId.replace(/-/g, "").slice(0, 8)
  same("03-near-bad-tag", await call("leo", "POST", "/wall/near", { tag: "xyz", rssi: -40 }))
  same("03-near-bad-rssi", await call("leo", "POST", "/wall/near", { tag, rssi: 5 }))
  same("03-near-other-wall", await call("leo", "POST", "/wall/near", { tag: "00000000", rssi: -40 }))
  const near = await seen(() => hub("POST", "/api/v1/wall/near", { token: pass.body.token, body: { tag, rssi: -42 } }))
  same("03-near", near.r)
  assert.deepEqual(near.events, ["wall:approach"])
  const again = await seen(() => call("leo", "POST", "/wall/near", { rssi: -40 }))
  assert.deepEqual(again.events, [], "no repeat announcement within 5 s")

  same("03-throw-not-near", await call("sofia", "POST", "/wall/throw", { kind: "list", id: ctx.groceries }))
  same("03-throw-bad-kind", await call("leo", "POST", "/wall/throw", { kind: "video", id: "x" }))
  same("03-throw-no-id", await call("leo", "POST", "/wall/throw", { kind: "list" }))
  same("03-throw-unknown", await call("leo", "POST", "/wall/throw", { kind: "list", id: NOBODY }))
  const thrown = await seen(() => call("leo", "POST", "/wall/throw", { kind: "list", id: ctx.groceries }))
  same("03-throw", thrown.r)
  assert.deepEqual(thrown.events, ["wall:throw"])
})

test("wall commands and what the walls report", async () => {
  same("03-command-child", await call("leo", "POST", "/hub/command", { type: "reload" }))
  same("03-command-unpaired", await call("unpaired", "POST", "/hub/command", { type: "reload" }))
  for (const [name, body] of Object.entries({
    unknown: { type: "explode" },
    orientation: { type: "set_orientation", orientation: "sideways" },
    idle: { type: "set_idle_mins", minutes: 0 },
    brightness: { type: "set_brightness", level: 2 },
    volume: { type: "set_volume", level: 101 },
    muted: { type: "set_muted", muted: "yes" },
    theme: { type: "set_theme", theme: "neon" },
    season: { type: "set_season", mode: "Not OK" },
    effects: { type: "set_season_effects", on: 1 },
  })) same(`03-command-bad-${name}`, await call("maya", "POST", "/hub/command", body))

  const cmd = await seen(() => call("maya", "POST", "/hub/command", { type: "set_brightness", level: 42.6 }))
  same("03-command", cmd.r)
  assert.deepEqual(cmd.events, ["hub:command"])
  for (const body of [{ type: "restart" }, { type: "set_idle_mins", minutes: null }, { type: "set_volume", level: 0 }, { type: "set_muted", muted: true },
    { type: "set_theme", theme: "dark" }, { type: "set_season", mode: "auto" }, { type: "set_season_effects", on: false }, { type: "set_orientation", orientation: "portrait" }]) {
    assert.equal((await call("wall", "POST", "/hub/command", body)).status, 200, JSON.stringify(body))
  }

  await call("wall", "POST", "/kiosk/display-state", { state: { screen: "home", brightness: 43 } })
  same("03-display-child", await call("leo", "GET", "/hub/display"))
  same("03-display-unpaired", await call("unpaired", "GET", "/hub/display"))
  same("03-display", await call("maya", "GET", "/hub/display"))
})

test("snapshot and activity log", async () => {
  const sortIn = (body) => ({
    ...body,
    members: sortList(body.members, "name"),
    chores: sortList(body.chores, "title"),
    notifications: sortList(body.notifications, "title"),
    meals: sortList(body.meals, "name"),
  })
  const snap = await call("leo", "GET", "/snapshot")
  same("03-snapshot", { status: snap.status, body: sortIn(snap.body) })
  same("03-snapshot-unpaired", await call("unpaired", "GET", "/snapshot"))

  const logs = await call("maya", "GET", "/activity-logs?limit=200")
  assert.ok(logs.body.length > 20)
  same("03-activity", sortedBy(logs, "summary"))
  same("03-activity-chores", sortedBy(await call("maya", "GET", "/activity-logs?category=chores"), "summary"))
  same("03-activity-bad-category", await call("maya", "GET", "/activity-logs?category=nope"))
  assert.equal((await call("maya", "GET", "/activity-logs?limit=2")).body.length, 2)
  assert.equal((await call("maya", "GET", "/activity-logs?before=2000-01-01")).body.length, 0)
})
