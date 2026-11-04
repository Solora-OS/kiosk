// Chapter 4 — photos and calendars: uploads (multipart and base64), reading
// a photo back whole or in chunks, the family's own iCal feed, a school
// calendar subscribed by link, and the Google / Microsoft settings (no real
// accounts: their tokens are stored expired, so nothing reaches Google).
import { test } from "node:test"
import assert from "node:assert/strict"
import { ctx, hub, broadcasts, snapshot, sortedBy, sortList, lanServer } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)
const as = (who) => ({ maya: ctx.mayaAccount, daniel: ctx.danielAccount, rosa: ctx.rosaAccount, sofia: ctx.sofia.token, leo: ctx.leo.token, wall: ctx.wallToken, unpaired: ctx.hallToken })[who]
const call = (who, method, path, body) => hub(method, `/api/v1${path}`, { token: as(who), body })
const NOBODY = "00000000-0000-4000-8000-000000000000"

// A 1×1 PNG, and 700 KB of PNG-typed bytes so chunking (512 KB parts) has two parts.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const BIG = Buffer.concat([PNG, Buffer.alloc(700 * 1024, 7)])

test("photos: upload, list, read back, delete", async () => {
  const form = new FormData()
  form.append("file", new Blob([PNG], { type: "image/png" }), "beach.PNG")
  form.append("caption", "  Beach day ")
  const { result: up, events } = await broadcasts(ctx.mayaSocket, () => hub("POST", "/api/v1/photos", { token: as("sofia"), body: form }))
  assert.equal(up.status, 201)
  same("04-photo-upload", up)
  assert.deepEqual(events, ["photos:created"])
  ctx.photo = up.body

  const notImage = new FormData()
  notImage.append("file", new Blob(["hi"], { type: "text/plain" }), "notes.txt")
  same("04-photo-upload-not-image", await hub("POST", "/api/v1/photos", { token: as("sofia"), body: notImage }))
  same("04-photo-upload-nothing", await hub("POST", "/api/v1/photos", { token: as("sofia"), body: new FormData() }))

  same("04-photo-base64-bad", await call("leo", "POST", "/photos/base64", { data: "abc", mime: "image/bmp" }))
  same("04-photo-base64-too-big", await call("leo", "POST", "/photos/base64", { data: Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64"), mime: "image/png" }))
  const relayed = await call("leo", "POST", "/photos/base64", { data: BIG.toString("base64"), mime: "image/jpeg", caption: "x".repeat(250) })
  assert.equal(relayed.status, 201)
  assert.match(relayed.body.filename, /\.jpg$/)
  same("04-photo-base64", relayed)

  // The file itself, by the static route (header or ?token=) and by id.
  const file = await hub("GET", ctx.photo.src, { token: as("leo"), raw: true })
  assert.equal(file.status, 200)
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG)
  const byQuery = await fetch(`${ctx.hubUrl}${ctx.photo.src}?token=${encodeURIComponent(as("leo"))}`)
  assert.equal(byQuery.status, 200)
  assert.equal((await fetch(`${ctx.hubUrl}${ctx.photo.src}`)).status, 401)
  const byId = await hub("GET", `/api/v1/photos/${ctx.photo.id}/file`, { token: as("wall"), raw: true })
  assert.equal(byId.status, 200)
  assert.equal(byId.headers.get("content-type"), "image/png")
  same("04-photo-file-unknown", await call("leo", "GET", `/photos/${NOBODY}/file`))

  // In 512 KB chunks, for the relay.
  const first = await call("leo", "GET", `/photos/${relayed.body.id}/chunk?part=0`)
  const second = await call("leo", "GET", `/photos/${relayed.body.id}/chunk?part=1`)
  assert.equal(first.body.parts, 2)
  assert.deepEqual(Buffer.concat([Buffer.from(first.body.data, "base64"), Buffer.from(second.body.data, "base64")]), BIG)
  same("04-photo-chunk", first)
  same("04-photo-chunk-past-end", await call("leo", "GET", `/photos/${relayed.body.id}/chunk?part=2`))
  same("04-photo-chunk-unknown", await call("leo", "GET", `/photos/${NOBODY}/chunk`))

  same("04-photos", sortedBy(await call("rosa", "GET", "/photos"), "caption"))
  same("04-photo-delete-unknown", await call("maya", "DELETE", `/photos/${NOBODY}`))
  const del = await broadcasts(ctx.mayaSocket, () => call("maya", "DELETE", `/photos/${relayed.body.id}`))
  assert.equal(del.result.status, 204)
  assert.deepEqual(del.events, ["photos:deleted"])
  assert.equal((await hub("GET", relayed.body.src, { token: as("leo"), raw: true })).status, 404)

  // Pinch-throw a photo to the wall Leo is standing at.
  const tag = ctx.wallId.replace(/-/g, "").slice(0, 8)
  await call("leo", "POST", "/wall/near", { tag, rssi: -40 })
  same("04-throw-photo", await call("leo", "POST", "/wall/throw", { kind: "photo", id: ctx.photo.id }))
})

/** Dates relative to today at home, so the snapshots don't change daily. */
function homeDay(offset) {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
  const [y, m, d] = today.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + offset)).toISOString().slice(0, 10)
}
const compact = (iso) => iso.replace(/-/g, "")
function relabel(value) {
  const labels = new Map(Array.from({ length: 800 }, (_, i) => i - 60).map((n) => [homeDay(n), `<day${n >= 0 ? "+" : ""}${n}>`]))
  return JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === "string" && labels.has(v) ? labels.get(v) : v))
}

test("the family's own iCal feed", async () => {
  same("04-ics-token-other-household", await call("maya", "GET", `/ics/token/${NOBODY}`))
  const token = await hub("GET", `/ics/token/${ctx.householdId}`, { token: as("maya") })
  assert.equal(token.status, 200)
  same("04-ics-token", token)
  same("04-ics-link", await call("maya", "GET", "/ics-link"))

  const feed = await fetch(`${ctx.hubUrl}/ics/${token.body.token}`)
  assert.equal(feed.status, 200)
  assert.match(feed.headers.get("content-type"), /^text\/calendar/)
  const text = (await feed.text()).replace(/^DTSTAMP:.*$/gm, "DTSTAMP:<now>")
  same("04-ics-feed", { status: 200, body: text.split("\r\n") })
  assert.equal((await fetch(`${ctx.hubUrl}/ics/${"0".repeat(32)}`)).status, 404)
})

test("a school calendar subscribed by link", async (t) => {
  const school = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "X-WR-CALNAME:Lincoln Elementary",
    "BEGIN:VEVENT", "UID:open-house", `DTSTART;TZID=America/New_York:${compact(homeDay(10))}T190000`, `DTEND;TZID=America/New_York:${compact(homeDay(10))}T203000`,
    "SUMMARY:Open house\\, all grades", "LOCATION:Gym", "END:VEVENT",
    "BEGIN:VEVENT", "UID:break", `DTSTART;VALUE=DATE:${compact(homeDay(20))}`, `DTEND;VALUE=DATE:${compact(homeDay(25))}`, "SUMMARY:Spring break", "END:VEVENT",
    "BEGIN:VEVENT", "UID:pe", `DTSTART;TZID=America/Chicago:${compact(homeDay(3))}T090000`, `DTEND;TZID=America/Chicago:${compact(homeDay(3))}T094500`,
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", `EXDATE;TZID=America/Chicago:${compact(homeDay(10))}T090000`, "SUMMARY:PE", "END:VEVENT",
    "BEGIN:VEVENT", "UID:assembly", `DTSTART;VALUE=DATE:${compact(homeDay(5))}`, "RRULE:FREQ=MONTHLY;BYDAY=1FR;COUNT=3", "SUMMARY:Assembly", "END:VEVENT",
    "BEGIN:VEVENT", "UID:old", `DTSTART;VALUE=DATE:${compact(homeDay(-90))}`, "SUMMARY:Long gone", "END:VEVENT",
    "BEGIN:VEVENT", "UID:cancelled", "STATUS:CANCELLED", `DTSTART;VALUE=DATE:${compact(homeDay(12))}`, "SUMMARY:Cancelled", "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n")
  let current = school
  const base = await lanServer({ "/school.ics": () => current, "/not-a-calendar": "<html></html>" })
  if (!base) { t.skip("no LAN address: the hub won't fetch from localhost"); return }

  same("04-link-child", await call("leo", "POST", "/calendar-links", { url: `${base}/school.ics` }))
  same("04-link-not-a-link", await call("maya", "POST", "/calendar-links", { url: "school calendar" }))
  same("04-link-ftp", await call("maya", "POST", "/calendar-links", { url: "ftp://example.com/x.ics" }))
  same("04-link-localhost", await call("maya", "POST", "/calendar-links", { url: "http://localhost:8080/x.ics" }))
  same("04-link-404", await call("maya", "POST", "/calendar-links", { url: `${base}/missing.ics` }))
  same("04-link-not-calendar", await call("maya", "POST", "/calendar-links", { url: `${base}/not-a-calendar` }))

  const added = await broadcasts(ctx.mayaSocket, () => call("daniel", "POST", "/calendar-links", { url: `${base}/school.ics`, calendarId: ctx.schoolCalendar }))
  assert.equal(added.result.status, 201, JSON.stringify(added.result.body))
  same("04-link-add", added.result)
  assert.deepEqual(added.events, ["events:updated"])
  const link = added.result.body
  same("04-link-duplicate", await call("maya", "POST", "/calendar-links", { url: `${base}/school.ics` }))

  const linked = (await call("leo", "GET", "/events")).body.filter((e) => e.source === "ics")
  same("04-linked-events", { status: 200, body: relabel(sortList(linked.filter((e) => e.title !== "Assembly"), "title")) })
  const assemblies = linked.filter((e) => e.title === "Assembly")
  assert.equal(assemblies.length, 3, "monthly first Fridays, COUNT=3")
  for (const a of assemblies) {
    const d = new Date(`${a.date}T00:00:00Z`)
    assert.equal(d.getUTCDay(), 5)
    assert.ok(d.getUTCDate() <= 7)
  }

  // The school drops PE and renames the open house.
  current = school.replace(/BEGIN:VEVENT\r\nUID:pe[\s\S]*?END:VEVENT\r\n/, "").replace("Open house\\, all grades", "Open house")
  same("04-link-sync", await call("maya", "POST", `/calendar-links/${link.id}/sync`, {}))
  same("04-linked-events-after-sync", { status: 200, body: relabel(sortList((await call("leo", "GET", "/events")).body.filter((e) => e.source === "ics" && e.title !== "Assembly"), "title")) })

  // A broken feed is recorded on the link, not thrown.
  current = "nope"
  same("04-link-sync-broken", await call("maya", "POST", `/calendar-links/${link.id}/sync`, {}))
  current = school

  same("04-link-edit-child", await call("leo", "PATCH", `/calendar-links/${link.id}`, { name: "x" }))
  same("04-link-edit-unknown", await call("maya", "PATCH", `/calendar-links/${NOBODY}`, { name: "x" }))
  same("04-link-edit", await call("maya", "PATCH", `/calendar-links/${link.id}`, { name: " Lincoln Elem. ", calendarId: null }))
  same("04-links", await call("sofia", "GET", "/calendar-links"))
  same("04-link-sync-unknown", await call("maya", "POST", `/calendar-links/${NOBODY}/sync`, {}))
  same("04-link-delete-child", await call("leo", "DELETE", `/calendar-links/${link.id}`))
  same("04-link-delete-unknown", await call("maya", "DELETE", `/calendar-links/${NOBODY}`))
  assert.equal((await call("maya", "DELETE", `/calendar-links/${link.id}`)).status, 204)
  assert.equal((await call("leo", "GET", "/events")).body.filter((e) => e.source === "ics").length, 0, "its events go with it")
})

test("Google and Microsoft calendars, without real accounts", async () => {
  same("04-providers-none", await call("maya", "GET", "/calendar-providers"))
  same("04-provider-unsupported", await call("maya", "POST", "/calendar-providers/yahoo/exchange", { code: "c", code_verifier: "v", redirect_uri: "r" }))
  same("04-provider-exchange-missing", await call("maya", "POST", "/calendar-providers/google/exchange", { code: "c" }))
  same("04-provider-exchange-google-unconfigured", await call("maya", "POST", "/calendar-providers/google/exchange", { code: "c", code_verifier: "v", redirect_uri: "r" }))
  same("04-provider-exchange-microsoft-unconfigured", await call("maya", "POST", "/calendar-providers/microsoft/exchange", { code: "c", code_verifier: "v", redirect_uri: "r" }))
  same("04-provider-tokens-unsupported", await call("maya", "POST", "/calendar-providers/yahoo/tokens", { access_token: "x" }))
  same("04-provider-tokens-missing", await call("maya", "POST", "/calendar-providers/google/tokens", {}))

  // Expired and no refresh token: stored, but sync stops before calling Google.
  same("04-provider-tokens", await call("maya", "POST", "/calendar-providers/google/tokens", { access_token: "ya29.fake", expires_at: 1, email: "maya@gmail.test" }))
  same("04-provider-tokens-again", await call("maya", "POST", "/calendar-providers/google/tokens", { access_token: "ya29.fake2", expires_at: 1, email: "maya@gmail.test" }))
  same("04-providers", await call("maya", "GET", "/calendar-providers"))
  same("04-provider-calendars-expired", await call("maya", "GET", "/calendar-providers/google/external-calendars"))
  same("04-provider-calendars-microsoft-none", await call("maya", "GET", "/calendar-providers/microsoft/external-calendars"))
  same("04-provider-events-expired", await call("maya", "GET", "/calendar-providers/google/calendars/primary/events"))
  same("04-provider-events-microsoft-none", await call("maya", "GET", "/calendar-providers/microsoft/calendars/Family/events"))
  same("04-provider-sync", await call("maya", "POST", "/calendar-providers/sync", {}))

  same("04-mappings-not-array", await call("maya", "PUT", "/calendar-providers/mappings", { provider: "google" }))
  same("04-mappings-set", await call("maya", "PUT", "/calendar-providers/mappings", [
    { provider: "google", externalId: "primary", externalName: "Maya", calendarId: ctx.schoolCalendar },
    { provider: "google", externalId: "work" }, { externalId: "skipped" },
  ]))
  await call("maya", "PUT", "/calendar-providers/mappings", [{ provider: "google", externalId: "primary", externalName: "Maya (personal)", calendarId: null }])
  same("04-mappings", sortedBy(await call("maya", "GET", "/calendar-providers/mappings"), "externalId"))
  same("04-excluded-not-array", await call("maya", "PUT", "/calendar-providers/excluded-events", {}))
  same("04-excluded-set", await call("maya", "PUT", "/calendar-providers/excluded-events", [{ provider: "google", eventId: "e1" }, { provider: "google", eventId: "e2" }, { provider: "google" }]))
  await call("maya", "PUT", "/calendar-providers/excluded-events", [{ provider: "google", eventId: "e2" }])
  same("04-excluded", await call("maya", "GET", "/calendar-providers/excluded-events"))
  same("04-provider-lists-unpaired", { status: 200, body: [(await call("unpaired", "GET", "/calendar-providers/mappings")).body, (await call("unpaired", "GET", "/calendar-providers/excluded-events")).body] })

  assert.equal((await call("maya", "DELETE", "/calendar-providers/google")).status, 204)
  same("04-providers-after-disconnect", await call("maya", "GET", "/calendar-providers"))
})
