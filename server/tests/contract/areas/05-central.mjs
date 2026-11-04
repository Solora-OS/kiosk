// Chapter 5 — Solora's service, through central: Grandma's phone using the
// hub from another city (the encrypted relay), Solora asking for support
// access and the family deciding, something Solora does showing up in the
// family's activity log, and a wall display reported lost.
import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { ctx, hub, central, centralFile, broadcasts, snapshot, sortedBy } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)
const as = (who) => ({ maya: ctx.mayaAccount, daniel: ctx.danielAccount, leo: ctx.leo.token, wall: ctx.wallToken })[who]
const call = (who, method, path, body) => hub(method, `/api/v1${path}`, { token: as(who), body })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const NOBODY = "00000000-0000-4000-8000-000000000000"

/** What mobile/src/lib/api.ts (relayReq) sends through central/routes/relay.ts. */
async function relay(payload, keyHex = ctx.remoteKey) {
  const key = Buffer.from(keyHex, "hex")
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([c.update(JSON.stringify(payload)), c.final(), c.getAuthTag()])
  const r = await central("POST", "/relay/rpc", { body: { hub_id: ctx.centralHubId, iv: iv.toString("base64"), encrypted_payload: ct.toString("base64") } })
  if (r.status !== 200 || !r.body.ciphertext) return r
  const full = Buffer.from(r.body.ciphertext, "base64")
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(r.body.iv, "base64"))
  d.setAuthTag(full.subarray(-16))
  return JSON.parse(Buffer.concat([d.update(full.subarray(0, -16)), d.final()]).toString())
}

test("Grandma uses the hub from another city, through the relay", async () => {
  ctx.centralHubId = (await hub("GET", "/central-identity", { token: as("maya") })).body.hub_id
  const rosa = (await call("maya", "GET", "/members")).body.find((m) => m.name === "Rosa")
  const me = { userId: rosa.userId, householdId: ctx.householdId }

  const members = await relay({ method: "GET", path: "/members", ...me })
  assert.equal(members.status, 200)
  same("05-relay-members", sortedBy(members, "name"))
  const added = await relay({ method: "POST", path: "/lists/" + ctx.groceries + "/items", body: { label: "Tamales" }, ...me })
  assert.equal(added.status, 201)
  same("05-relay-write", added)
  // Only the app's own API paths, and only with the household's key.
  same("05-relay-blocked-path", await relay({ method: "POST", path: "/transfer/start", ...me }))
  same("05-relay-wrong-key", await relay({ method: "GET", path: "/members", ...me }, "00".repeat(32)))
})

test("Solora asks for support access; the family decides", async () => {
  same("05-support-child", await call("leo", "GET", "/support/grants"))
  same("05-support-wall", await call("wall", "GET", "/support/activity"))
  same("05-support-before", await call("maya", "GET", "/support/grants"))

  const { result: asked, events } = await broadcasts(ctx.mayaSocket, async () => {
    const r = await central("POST", `/admin/hubs/${ctx.centralHubId}/support-requests`, {
      admin: true, body: { duration_hours: 24, audit_reason: "Your display couldn't update; we'd like to read its logs." },
    })
    await wait(300)
    return r
  })
  assert.equal(asked.status, 201, JSON.stringify(asked.body))
  assert.ok(events.includes("notifications:created"), "admins hear about the request")
  const note = (await call("maya", "GET", "/notifications")).body.find((n) => n.ref === "support")
  same("05-support-notification", { status: 200, body: note })
  assert.equal((await call("daniel", "GET", "/notifications")).body.some((n) => n.ref === "support"), false, "only admins")

  const grants = await call("maya", "GET", "/support/grants")
  same("05-support-grants", grants)
  // The open request (chapter 1b's was denied).
  const id = grants.body.grants.find((g) => g.status === "requested").id
  same("05-support-respond-bad", await call("maya", "POST", `/support/grants/${id}/respond`, { decision: "maybe" }))
  same("05-support-respond-unknown", await call("maya", "POST", `/support/grants/${NOBODY}/respond`, { decision: "grant" }))
  same("05-support-grant", await call("maya", "POST", `/support/grants/${id}/respond`, { decision: "grant" }))
  same("05-support-revoke", await call("maya", "POST", `/support/grants/${id}/revoke`, {}))
})

test("what Solora does to the hub shows up in the family's log", async () => {
  const centralWall = centralFile().kiosks[ctx.wallId].central_device_id
  ctx.centralWallId = centralWall
  const r = await central("POST", `/admin/devices/${centralWall}/reboot`, { admin: true, body: { audit_reason: "Display stuck on a blank screen" } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let activity
  for (let i = 0; i < 20; i++) {
    activity = await call("maya", "GET", "/support/activity")
    if (activity.body.some((a) => a.action === "solora.device.reboot")) break
    await wait(200)
  }
  same("05-support-activity", sortedBy(activity, "summary"))
  const log = (await call("maya", "GET", "/activity-logs?category=hub")).body.find((a) => a.action === "solora.device.reboot")
  same("05-activity-solora", { status: 200, body: log })
})

test("a wall display reported lost is locked through central", async () => {
  same("05-lost-bad", await call("maya", "POST", `/support/devices/${ctx.wallId}/lost`, { lost: "yes" }))
  same("05-lost-unknown", await call("maya", "POST", `/support/devices/${NOBODY}/lost`, { lost: true }))
  same("05-lost", await call("maya", "POST", `/support/devices/${ctx.wallId}/lost`, { lost: true }))
  const status = await central("GET", "/devices/lock-status", { token: centralFile().kiosks[ctx.wallId].central_jwt })
  assert.equal(status.body.locked, true)
  same("05-found", await call("maya", "POST", `/support/devices/${ctx.wallId}/lost`, { lost: false }))
  same("05-support-activity-after-lost", sortedBy(await call("maya", "GET", "/support/activity"), "summary"))
})
