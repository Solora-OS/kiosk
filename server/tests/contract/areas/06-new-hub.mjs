// Chapter 6 — moving to a new hub: Maya starts a move on the old hub, the
// new hub's own screen pulls the household (rows, photos, calendar tokens)
// sealed under the transfer code, and the family carries on there.
import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { ctx, hub, snapshot, startHub, sortedBy } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)

/** services/hub-transfer.ts `open`: iv (12) ‖ ciphertext ‖ tag (16), key = scrypt(code). */
function unseal(code, sealed) {
  const key = crypto.scryptSync(code, "solora-hub-transfer", 32)
  const d = crypto.createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12))
  d.setAuthTag(sealed.subarray(-16))
  return Buffer.concat([d.update(sealed.subarray(12, -16)), d.final()])
}

test("the old hub hands over the household, sealed under a one-time code", async () => {
  same("06-start-not-admin", await hub("POST", "/api/v1/transfer/start", { token: ctx.danielAccount, body: {} }))
  const start = await hub("POST", "/api/v1/transfer/start", { token: ctx.mayaAccount, body: {} })
  assert.equal(start.status, 200)
  assert.match(start.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
  same("06-start", start)
  ctx.transferCode = start.body.code

  same("06-export-no-code", await hub("GET", "/api/v1/transfer/export"))
  same("06-finish-no-code", await hub("POST", "/api/v1/transfer/finish", { body: {} }))
  same("06-export-wrong-code", await hub("GET", "/api/v1/transfer/export", { headers: { "X-Transfer-Code": "AAAA-AAAA" } }))
  const sloppy = ctx.transferCode.toLowerCase().replace("-", " ")
  const exported = await hub("GET", "/api/v1/transfer/export", { headers: { "X-Transfer-Code": sloppy }, raw: true })
  assert.equal(exported.status, 200)
  const archive = JSON.parse(unseal(ctx.transferCode, Buffer.from(await exported.arrayBuffer())).toString("utf8"))
  assert.equal(archive.format, 1)
  assert.equal(archive.householdId, ctx.householdId)
  const counts = Object.fromEntries(Object.entries(archive.tables).map(([t, rows]) => [t, rows.length]))
  same("06-export-counts", { status: 200, body: { counts, photos: archive.photos.length } })

  const photo = await hub("GET", `/api/v1/transfer/photo/${encodeURIComponent(archive.photos[0])}`, { headers: { "X-Transfer-Code": ctx.transferCode }, raw: true })
  assert.equal(photo.status, 200)
  assert.ok(unseal(ctx.transferCode, Buffer.from(await photo.arrayBuffer())).length > 0)
  same("06-photo-not-theirs", await hub("GET", "/api/v1/transfer/photo/someone-else.jpg", { headers: { "X-Transfer-Code": ctx.transferCode } }))
})

test("the new hub's own screen pulls the household", async () => {
  const next = await startHub("hub2")
  ctx.hub2 = next
  // Its screen is up before the move, and joins the household it pulls.
  const screen = await hub("POST", "/api/v1/kiosk/register", { base: next.url, body: { device_name: "New Kitchen Wall" } })
  assert.equal(screen.status, 201)

  if (next.lanUrl) same("06-pull-from-lan", await hub("POST", "/api/v1/transfer/pull", { base: next.lanUrl, body: { code: ctx.transferCode, from: ctx.hubUrl } }))
  same("06-pull-no-code", await hub("POST", "/api/v1/transfer/pull", { base: next.url, body: {} }))
  same("06-pull-bad-address", await hub("POST", "/api/v1/transfer/pull", { base: next.url, body: { code: ctx.transferCode, from: "http://" } }))
  same("06-pull-wrong-code", await hub("POST", "/api/v1/transfer/pull", { base: next.url, body: { code: "BBBB-BBBB", from: ctx.hubUrl } }))

  const pulled = await hub("POST", "/api/v1/transfer/pull", { base: next.url, body: { code: ctx.transferCode, from: ctx.hubUrl.replace("http://", "") } })
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body))
  same("06-pull", pulled)

  // The old hub's move is over.
  same("06-export-after-finish", await hub("GET", "/api/v1/transfer/export", { headers: { "X-Transfer-Code": ctx.transferCode } }))
  same("06-pull-again", await hub("POST", "/api/v1/transfer/pull", { base: next.url, body: { code: ctx.transferCode, from: ctx.hubUrl } }))

  // The family carries on: same household, same people, photos came along.
  const session = await hub("POST", "/api/v1/auth/session", { base: next.url, body: { access_token: ctx.mayaAccount } })
  assert.equal(session.status, 200)
  assert.equal(session.body.household.id, ctx.householdId)
  same("06-new-hub-members", sortedBy(await hub("GET", "/api/v1/members", { base: next.url, token: ctx.mayaAccount }), "name"))
  const state = await hub("GET", "/api/v1/kiosk/state", { base: next.url, token: screen.body.device_token })
  assert.equal(state.body.household_id, ctx.householdId)
  const photos = await hub("GET", "/api/v1/photos", { base: next.url, token: ctx.mayaAccount })
  const file = await hub("GET", photos.body[0].src, { base: next.url, token: ctx.mayaAccount, raw: true })
  assert.equal(file.status, 200)
  same("06-new-hub-info", await hub("GET", "/api/v1/hub/info", { base: next.url }))
})
