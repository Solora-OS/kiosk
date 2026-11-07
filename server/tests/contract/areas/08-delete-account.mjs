// Chapter 8 — a standing code, then leaving for good, on the new hub. A
// reviewer's code (invites.reusable) reconnects its account as often as it's
// used and refuses anyone else. Daniel deletes his account:
// only he and his profile go. Then Maya, the last admin, deletes hers and the
// household goes with her: the hub is back to unclaimed, photos and all.
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { ctx, hub, signup } from "../harness.mjs"

test("a standing reviewer code reconnects its account and refuses others", async () => {
  const base = ctx.hub2.url
  const db = new Database(path.join(ctx.hub2.home, ".solora", "solora.db"))
  db.prepare("INSERT INTO members (id, household_id, name, initial, color, role, permissions, pending) VALUES ('m-review', ?, 'Reviewer', 'R', 'teal', 'adult', '[]', 1)").run(ctx.householdId)
  db.prepare("INSERT INTO invites (id, household_id, member_id, token, code, name, role, color, expires_at, reusable) VALUES ('i-review', ?, 'm-review', 'review-token', 'REVW-0001', 'Reviewer', 'adult', 'teal', '2099-01-01T00:00:00.000Z', 1)").run(ctx.householdId)
  db.close()

  const reviewer = await signup("review@store.test", "Reviewer")
  ctx.reviewerAccount = reviewer
  const claim = () => hub("POST", "/api/v1/invites/claim", { base, body: { token: "review-token", access_token: reviewer, name: "Reviewer" } })
  const first = await claim()
  assert.equal(first.status, 201, JSON.stringify(first.body))
  assert.equal(first.body.household.id, ctx.householdId)
  assert.ok(first.body.remoteKey)
  const again = await claim()
  assert.equal(again.status, 201, "the same account can use it again")
  assert.equal(again.body.user.id, first.body.user.id)
  assert.equal((await hub("GET", "/api/v1/invites/REVW-0001", { base })).status, 200, "never used up")

  const stranger = await signup("stranger@store.test", "Stranger")
  const taken = await hub("POST", "/api/v1/invites/claim", { base, body: { token: "review-token", access_token: stranger, name: "Stranger" } })
  assert.equal(taken.status, 409)
})

test("a shared testers code gives each account its own member and reconnects on reuse", async () => {
  const base = ctx.hub2.url
  const db = new Database(path.join(ctx.hub2.home, ".solora", "solora.db"))
  db.prepare("INSERT INTO invites (id, household_id, member_id, token, code, name, role, color, expires_at, reusable, shared) VALUES ('i-testers', ?, 'm-review', 'testers-token', 'TST-0001', 'Testers', 'adult', 'teal', '2099-01-01T00:00:00.000Z', 1, 1)").run(ctx.householdId)
  db.close()

  const found = await hub("GET", "/api/v1/invites/TST-0001", { base })
  assert.equal(found.status, 200)
  assert.equal(found.body.memberName, "", "each tester types their own name")

  const claim = (token, name) => hub("POST", "/api/v1/invites/claim", { base, body: { token: "testers-token", access_token: token, name } })
  const ann = await signup("ann@testers.test", "Ann")
  const bob = await signup("bob@testers.test", "Bob")
  const a = await claim(ann, "Ann")
  const b = await claim(bob, "Bob")
  assert.equal(a.status, 201, JSON.stringify(a.body))
  assert.equal(b.status, 201, JSON.stringify(b.body))
  assert.notEqual(a.body.user.id, b.body.user.id)
  assert.equal((await claim(ann, "Ann")).body.user.id, a.body.user.id, "the same account reconnects")

  const db2 = new Database(path.join(ctx.hub2.home, ".solora", "solora.db"))
  const testers = db2.prepare("SELECT m.name, m.role, m.permissions, m.pending FROM members m JOIN users u ON u.id = m.user_id WHERE u.email LIKE '%@testers.test' ORDER BY m.name").all()
  const anchor = db2.prepare("SELECT user_id FROM members WHERE id = 'm-review'").get()
  db2.prepare("DELETE FROM invites WHERE id = 'i-testers'").run()
  db2.close()
  assert.deepEqual(testers, [
    { name: "Ann", role: "adult", permissions: '["calendar","chores","lists","meals"]', pending: 0 },
    { name: "Bob", role: "adult", permissions: '["calendar","chores","lists","meals"]', pending: 0 },
  ], "one member each, and no reconnect duplicates")
  assert.ok(anchor.user_id, "the anchor stays the reviewer's")
  assert.notEqual(anchor.user_id, a.body.user.id)
})

test("resetting the hub's data clears events, chores, lists and meals, and keeps the family", async () => {
  const base = ctx.hub2.url
  const count = async (p) => (await hub("GET", p, { base, token: ctx.mayaAccount })).body.length
  const membersBefore = await count("/api/v1/members")
  assert.ok((await count("/api/v1/events")) > 0, "there is something to clear")
  assert.equal((await hub("POST", "/api/v1/hub/reset-data", { base, token: ctx.reviewerAccount })).status, 403, "only with hub access")
  const r = await hub("POST", "/api/v1/hub/reset-data", { base, token: ctx.mayaAccount })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.ok(r.body.events > 0)
  for (const p of ["/api/v1/events", "/api/v1/chores", "/api/v1/lists", "/api/v1/meals"]) assert.equal(await count(p), 0, p)
  assert.equal(await count("/api/v1/members"), membersBefore)
  assert.ok((await count("/api/v1/photos")) > 0, "photos stay")
})

test("an adult deleting their account leaves the rest of the family", async () => {
  const base = ctx.hub2.url
  assert.equal((await hub("DELETE", "/api/v1/auth/account", { base })).status, 401)
  const before = await hub("GET", "/api/v1/members", { base, token: ctx.mayaAccount })
  const gone = await hub("DELETE", "/api/v1/auth/account", { base, token: ctx.danielAccount })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  assert.deepEqual(gone.body, { wiped: false })

  const after = await hub("GET", "/api/v1/members", { base, token: ctx.mayaAccount })
  assert.equal(after.body.length, before.body.length - 1)
  assert.ok(!after.body.some((m) => m.userId === ctx.danielUserId), "Daniel's profile is gone")
  // His account token no longer finds a household here.
  assert.deepEqual((await hub("GET", "/api/v1/members", { base, token: ctx.danielAccount })).body, [])
  assert.equal((await hub("GET", "/api/v1/hub/info", { base })).body.claimed, true)
})

test("the last admin deleting their account wipes the household", async () => {
  const base = ctx.hub2.url
  const photosDir = path.join(ctx.hub2.home, ".solora", "photos")
  assert.ok(fs.readdirSync(photosDir).length > 0, "the moved photos are on disk")

  const gone = await hub("DELETE", "/api/v1/auth/account", { base, token: ctx.mayaAccount })
  assert.equal(gone.status, 200, JSON.stringify(gone.body))
  assert.deepEqual(gone.body, { wiped: true })

  assert.equal((await hub("GET", "/api/v1/hub/info", { base })).body.claimed, false)
  assert.deepEqual((await hub("GET", "/api/v1/members", { base, token: ctx.mayaAccount })).body, [])
  assert.deepEqual(fs.readdirSync(photosDir), [], "photo files are deleted too")
})
