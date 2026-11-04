// Chapter 1b — the hub answering central, right after unboxing: Maya's phone
// away from home through the encrypted relay, Solora asking for support
// access (and Maya saying no), and something Solora does to the wall showing
// up in the family's log. Only what chapter 1 set up is needed. (Invites
// through central are in chapter 2; a lost display in chapter 5.)
import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { ctx, hub, central, centralFile, broadcasts, snapshot, sortedBy } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** What mobile/src/lib/api.ts (relayReq) sends through central/routes/relay.ts. */
async function relay(payload, keyHex) {
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

test("Maya's phone away from home, through the relay", async () => {
  ctx.centralHubId = (await hub("GET", "/central-identity", { token: ctx.mayaAccount })).body.hub_id
  const me = { userId: ctx.mayaUserId, householdId: ctx.householdId }
  const session = await relay({ method: "GET", path: "/auth/me", ...me }, ctx.remoteKey)
  assert.equal(session.status, 200)
  same("01b-relay-session", session)
  same("01b-relay-blocked-path", await relay({ method: "POST", path: "/auth/session", ...me }, ctx.remoteKey))
  same("01b-relay-path-with-query", await relay({ method: "GET", path: "/auth/me?x=1", ...me }, ctx.remoteKey))
  same("01b-relay-wrong-key", await relay({ method: "GET", path: "/auth/me", ...me }, "11".repeat(32)))
})

test("support routes are for family admins", async () => {
  same("01b-support-wall", await hub("GET", "/api/v1/support/grants", { token: ctx.wallToken }))
  same("01b-support-wall-unknown-path", await hub("GET", "/api/v1/support/nope", { token: ctx.wallToken }))
  same("01b-support-unknown-path", await hub("GET", "/api/v1/support/nope", { token: ctx.mayaAccount }))
  same("01b-support-no-token", await hub("GET", "/api/v1/support/activity"))
  same("01b-support-grants-none", await hub("GET", "/api/v1/support/grants", { token: ctx.mayaAccount }))
  same("01b-lost-not-boolean", await hub("POST", `/api/v1/support/devices/${ctx.wallId}/lost`, { token: ctx.mayaAccount, body: {} }))
})

test("Solora asks for support access; Maya says no", async () => {
  const { result: asked, events } = await broadcasts(ctx.mayaSocket, async () => {
    const r = await central("POST", `/admin/hubs/${ctx.centralHubId}/support-requests`, {
      admin: true, body: { duration_hours: 72, audit_reason: "Checking why the wall restarted overnight." },
    })
    await wait(300)
    return r
  })
  assert.equal(asked.status, 201, JSON.stringify(asked.body))
  const note = ctx.mayaSocket.events.findLast((e) => e.event === "notifications:created")
  assert.ok(events.includes("notifications:created"), "the admin hears about it")
  same("01b-support-notification", { status: 200, body: note.payload })

  const grants = await hub("GET", "/api/v1/support/grants", { token: ctx.mayaAccount })
  same("01b-support-grants", grants)
  const id = grants.body.grants[0].id
  same("01b-support-respond-bad", await hub("POST", `/api/v1/support/grants/${id}/respond`, { token: ctx.mayaAccount, body: { decision: "later" } }))
  same("01b-support-deny", await hub("POST", `/api/v1/support/grants/${id}/respond`, { token: ctx.mayaAccount, body: { decision: "deny" } }))
  same("01b-support-revoke-denied", await hub("POST", `/api/v1/support/grants/${id}/revoke`, { token: ctx.mayaAccount, body: {} }))
})

test("what Solora does to the wall shows up in the family's log", async () => {
  const centralWall = centralFile().kiosks[ctx.wallId].central_device_id
  const r = await central("POST", `/admin/devices/${centralWall}/report-status`, { admin: true, body: { audit_reason: "Wall reported a slow network" } })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  let activity
  for (let i = 0; i < 20; i++) {
    activity = await hub("GET", "/api/v1/support/activity", { token: ctx.mayaAccount })
    if (activity.body.some((a) => a.action === "solora.device.report_status")) break
    await wait(200)
  }
  same("01b-support-activity", sortedBy(activity, "summary"))
})
