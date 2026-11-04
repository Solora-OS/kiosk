// Chapter 2 — the family joins: an adult with an account on the Wi-Fi, a teen
// and a child without accounts, tap-to-invite, grandma from another city
// through central, then members are edited and one is removed.
import { test } from "node:test"
import assert from "node:assert/strict"
import crypto from "node:crypto"
import { ctx, hub, central, signup, listen, broadcasts, snapshot, sortedBy } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function invite(body) {
  const r = await hub("POST", "/api/v1/invites", { token: ctx.mayaAccount, body })
  assert.equal(r.status, 201, JSON.stringify(r.body))
  return r
}

test("invites for each family member", async () => {
  same("02-invite-no-name", await hub("POST", "/api/v1/invites", { token: ctx.mayaAccount, body: {} }))
  same("02-invite-unknown-member", await hub("POST", "/api/v1/invites", { token: ctx.mayaAccount, body: { name: "X", memberId: "00000000-0000-4000-8000-000000000000" } }))

  const daniel = await invite({ name: "Daniel", role: "adult", color: "green", email: "daniel@family.test" })
  same("02-invite-daniel", daniel)
  ctx.danielInvite = daniel.body
  ctx.sofiaInvite = (await invite({ name: "Sofia", role: "teen", color: "purple", dob: "2012-04-03" })).body
  ctx.leoInvite = (await invite({ name: "Leo", role: "child", color: "orange", dob: "2019-08-21" })).body
  ctx.rosaInvite = (await invite({ name: "Rosa", role: "adult", color: "pink" })).body

  // Looked up by code (any case) or by QR token, without signing in.
  const byCode = await hub("GET", `/api/v1/invites/${ctx.danielInvite.code.toLowerCase()}`)
  assert.equal(byCode.status, 200)
  assert.equal(byCode.body.householdName, "The Okafor-Reyes Family")
  same("02-invite-lookup", byCode)
  assert.equal((await hub("GET", `/api/v1/invites/${ctx.danielInvite.token}`)).body.id, ctx.danielInvite.id)
  same("02-invite-lookup-unknown", await hub("GET", "/api/v1/invites/ZZZ-999"))

  // Re-inviting a member replaces their old invite.
  const again = await invite({ name: "Daniel", role: "adult", color: "green", email: "daniel@family.test", member_id: ctx.danielInvite.memberId })
  assert.equal(again.body.memberId, ctx.danielInvite.memberId)
  assert.equal((await hub("GET", `/api/v1/invites/${ctx.danielInvite.code}`)).status, 404)
  ctx.danielInvite = again.body
})

test("Daniel joins with his account", async () => {
  ctx.danielAccount = await signup("daniel@family.test", "Daniel")
  same("02-claim-missing", await hub("POST", "/api/v1/invites/claim", { body: { token: ctx.danielInvite.token } }))
  same("02-claim-bad-account", await hub("POST", "/api/v1/invites/claim", { body: { token: ctx.danielInvite.token, access_token: "x", name: "Daniel" } }))
  same("02-claim-unknown-invite", await hub("POST", "/api/v1/invites/claim", { body: { token: "inv_nope", access_token: ctx.danielAccount, name: "Daniel" } }))

  const claim = await hub("POST", "/api/v1/invites/claim", { body: { token: ctx.danielInvite.token, access_token: ctx.danielAccount, name: "Daniel" } })
  assert.equal(claim.status, 201)
  same("02-claim-daniel", claim)
  ctx.danielUserId = claim.body.user.id
  same("02-claim-reused", await hub("POST", "/api/v1/invites/claim", { body: { token: ctx.danielInvite.token, access_token: ctx.danielAccount, name: "Daniel" } }))
})

test("adults can't join as a device-only member; invites can be cancelled", async () => {
  const uncle = await invite({ name: "Uncle Ben", role: "adult" })
  same("02-claim-device-adult", await hub("POST", "/api/v1/invites/claim-device", { body: { token: uncle.body.token, name: "Ben" } }))
  same("02-claim-device-missing", await hub("POST", "/api/v1/invites/claim-device", { body: { token: uncle.body.token } }))
  same("02-invite-cancel", await hub("DELETE", `/api/v1/invites/${uncle.body.id}`, { token: ctx.mayaAccount }))
  same("02-invite-cancel-again", await hub("DELETE", `/api/v1/invites/${uncle.body.id}`, { token: ctx.mayaAccount }))
  ctx.uncleMemberId = uncle.body.memberId
})

test("Sofia and Leo join on their own phones, no accounts", async () => {
  const sofia = await hub("POST", "/api/v1/invites/claim-device", { body: { token: ctx.sofiaInvite.token, name: "Sofia" } })
  assert.equal(sofia.status, 201)
  same("02-claim-device-sofia", sofia)
  ctx.sofia = sofia.body

  const leo = await hub("POST", "/api/v1/invites/claim-device", { body: { token: ctx.leoInvite.token, name: "Leo", color: "yellow" } })
  assert.equal(leo.status, 201)
  ctx.leo = leo.body

  // Next morning: the phone swaps its refresh token for a fresh pair.
  const refreshed = await hub("POST", "/api/v1/auth/device-refresh", { body: { refresh_token: ctx.leo.refreshToken } })
  assert.equal(refreshed.status, 200)
  same("02-device-refresh", refreshed)
  ctx.leo = { ...ctx.leo, ...refreshed.body }
  assert.equal((await hub("GET", "/api/v1/members", { token: ctx.leo.token })).status, 200)
})

test("tap to invite: a nearby phone answers, the inviter checks the number", async () => {
  const cousin = await invite({ name: "Mateo", role: "child" })
  const id = cousin.body.id
  same("02-tap-unknown-invite", await hub("POST", "/api/v1/invites/00000000-0000-4000-8000-000000000000/tap", { token: ctx.mayaAccount, body: {} }))
  const tap = await hub("POST", `/api/v1/invites/${id}/tap`, { token: ctx.mayaAccount, body: {} })
  assert.equal(tap.status, 201)
  same("02-tap", tap)
  const ticket = tap.body.ticket

  same("02-tap-poll-open", await hub("GET", `/api/v1/invites/${id}/tap/${ticket}`, { token: ctx.mayaAccount }))
  same("02-tap-approve-early", await hub("POST", `/api/v1/invites/${id}/tap/${ticket}/approve`, { token: ctx.mayaAccount, body: {} }))
  same("02-tap-no-check", await hub("GET", `/api/v1/invites/${ticket}`))
  same("02-tap-answer", await hub("GET", `/api/v1/invites/${ticket}.4821`))
  same("02-tap-other-phone", await hub("GET", `/api/v1/invites/${ticket}.1111`))
  same("02-tap-poll-requested", await hub("GET", `/api/v1/invites/${id}/tap/${ticket}`, { token: ctx.mayaAccount }))
  same("02-tap-approve", await hub("POST", `/api/v1/invites/${id}/tap/${ticket}/approve`, { token: ctx.mayaAccount, body: {} }))
  const got = await hub("GET", `/api/v1/invites/${ticket}.4821`)
  assert.equal(got.status, 200)
  same("02-tap-invite", got)
  const mateo = await hub("POST", "/api/v1/invites/claim-device", { body: { token: got.body.token, name: "Mateo" } })
  assert.equal(mateo.status, 201)
  ctx.mateo = mateo.body

  // A denied ticket is dead.
  const second = await invite({ name: "Lucia", role: "child" })
  const t2 = (await hub("POST", `/api/v1/invites/${second.body.id}/tap`, { token: ctx.mayaAccount, body: {} })).body.ticket
  await hub("GET", `/api/v1/invites/${t2}.2222`)
  same("02-tap-deny", await hub("POST", `/api/v1/invites/${second.body.id}/tap/${t2}/deny`, { token: ctx.mayaAccount, body: {} }))
  same("02-tap-after-deny", await hub("GET", `/api/v1/invites/${t2}.2222`))
  same("02-tap-poll-unknown", await hub("GET", `/api/v1/invites/${second.body.id}/tap/tap_nope`, { token: ctx.mayaAccount }))
  ctx.luciaInvite = second.body
})

// What the mobile app does in mobile/src/lib/invite-remote.ts.
function remoteInvite(code) {
  const lookup = crypto.createHash("sha256").update(`lumora-invite:${code.trim().toUpperCase()}`).digest("hex")
  const me = crypto.createECDH("prime256v1")
  me.generateKeys()
  let key = null
  return {
    lookup,
    async open() {
      const r = await central("GET", `/invites/${lookup}`)
      if (r.status !== 200) return r
      const secret = me.computeSecret(Buffer.from(r.body.hub_pub, "base64"))
      key = Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from("lumora-invite"), Buffer.from(lookup), 32))
      return r
    },
    async call(payload) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv("aes-256-gcm", key, iv)
      const ct = Buffer.concat([c.update(JSON.stringify(payload)), c.final(), c.getAuthTag()])
      const r = await central("POST", `/invites/${lookup}/rpc`, {
        body: { client_pub: me.getPublicKey("base64", "uncompressed"), iv: iv.toString("base64"), encrypted_payload: ct.toString("base64") },
      })
      assert.equal(r.status, 200, JSON.stringify(r.body))
      const full = Buffer.from(r.body.ciphertext, "base64")
      const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(r.body.iv, "base64"))
      d.setAuthTag(full.subarray(-16))
      return JSON.parse(Buffer.concat([d.update(full.subarray(0, -16)), d.final()]).toString())
    },
  }
}

test("Grandma Rosa joins from another city, through central", async () => {
  const remote = remoteInvite(ctx.rosaInvite.code)
  let opened
  for (let i = 0; i < 20; i++) {
    opened = await remote.open()
    if (opened.status === 200) break
    await wait(250)
  }
  assert.equal(opened.status, 200, "the hub registered the invite with central")

  const looked = await remote.call({ op: "lookup", key: ctx.rosaInvite.code })
  assert.equal(looked.status, 200)
  same("02-remote-lookup", looked)
  // The call may only touch the invite central routed it by.
  same("02-remote-wrong-invite", await remote.call({ op: "lookup", key: ctx.luciaInvite.code }))

  const rosaAccount = await signup("rosa@family.test", "Rosa")
  const claimed = await remote.call({ op: "claim", key: ctx.rosaInvite.code, body: { token: ctx.rosaInvite.token, access_token: rosaAccount, name: "Rosa" } })
  assert.equal(claimed.status, 201)
  same("02-remote-claim", claimed)
  ctx.rosaAccount = rosaAccount

  let gone
  for (let i = 0; i < 20; i++) {
    gone = await central("GET", `/invites/${remote.lookup}`)
    if (gone.status === 404) break
    await wait(250)
  }
  assert.equal(gone.status, 404, "a claimed invite stops routing")
})

test("members: list, add, edit, remove (and a removed kid's phone signs out)", async () => {
  same("02-members", sortedBy(await hub("GET", "/api/v1/members", { token: ctx.mayaAccount }), "name"))
  same("02-members-unpaired-display", await hub("GET", "/api/v1/members", { token: ctx.hallToken }))
  same("02-member-add-unpaired-display", await hub("POST", "/api/v1/members", { token: ctx.hallToken, body: { name: "X" } }))
  same("02-member-add-no-name", await hub("POST", "/api/v1/members", { token: ctx.mayaAccount, body: {} }))

  const added = await broadcasts(ctx.mayaSocket, () =>
    hub("POST", "/api/v1/members", { token: ctx.mayaAccount, body: { name: "Biscuit", color: "yellow", role: "child", permissions: ["chores"] } }))
  same("02-member-add", added.result)
  assert.deepEqual(added.events.filter((e) => e.startsWith("members:")), ["members:created"])
  const biscuit = added.result.body

  same("02-member-edit-nothing", await hub("PATCH", `/api/v1/members/${biscuit.id}`, { token: ctx.mayaAccount, body: {} }))
  same("02-member-edit-unknown", await hub("PATCH", "/api/v1/members/00000000-0000-4000-8000-000000000000", { token: ctx.mayaAccount, body: { name: "Y" } }))
  const edited = await broadcasts(ctx.mayaSocket, () =>
    hub("PATCH", `/api/v1/members/${biscuit.id}`, { token: ctx.mayaAccount, body: { name: "biscuit the dog", dob: null, permissions: [], pending: false } }))
  same("02-member-edit", edited.result)
  assert.ok(edited.events.includes("members:updated"))

  // Daniel gets calendar, chores, lists and meals permissions.
  const daniel = (await hub("GET", "/api/v1/members", { token: ctx.mayaAccount })).body.find((m) => m.name === "Daniel")
  ctx.danielMemberId = daniel.id
  same("02-member-permissions", await hub("PATCH", `/api/v1/members/${daniel.id}`, { token: ctx.mayaAccount, body: { permissions: ["calendar", "chores", "lists", "meals"] } }))

  same("02-member-delete-unknown", await hub("DELETE", "/api/v1/members/00000000-0000-4000-8000-000000000000", { token: ctx.mayaAccount }))
  const removed = await broadcasts(ctx.mayaSocket, () => hub("DELETE", `/api/v1/members/${biscuit.id}`, { token: ctx.mayaAccount }))
  assert.equal(removed.result.status, 204)
  assert.ok(removed.events.includes("members:deleted"))

  // Mateo (tap invite) leaves: his phone's tokens stop working at once.
  const mateo = (await hub("GET", "/api/v1/members", { token: ctx.mayaAccount })).body.find((m) => m.name === "Mateo")
  const mateoUser = mateo.userId
  assert.ok(mateoUser)
  await hub("DELETE", `/api/v1/members/${mateo.id}`, { token: ctx.mayaAccount })
  same("02-removed-phone-access", await hub("GET", "/api/v1/members", { token: ctx.mateo.token }))
  same("02-removed-phone-refresh", await hub("POST", "/api/v1/auth/device-refresh", { body: { refresh_token: ctx.mateo.refreshToken } }))
  same("02-leo-still-in", { status: (await hub("GET", "/api/v1/members", { token: ctx.leo.token })).status, body: null })

  // Leo's phone keeps a socket too.
  ctx.leoSocket = await listen(ctx.leo.token)
  ctx.sofiaSocket = await listen(ctx.sofia.token)
})
