// Chapter 7 — the live events. Phones and walls rely on Socket.IO event
// names and payloads as much as on HTTP: this is every event Maya's, Sofia's
// and Leo's sockets received during the story, with the first payload of each.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ctx, snapshot } from "../harness.mjs"

test("every live event the family received, with its payload", () => {
  const first = {}
  const count = {}
  for (const s of [ctx.mayaSocket, ctx.sofiaSocket, ctx.leoSocket]) {
    for (const { event, payload } of s.events) {
      first[event] ??= payload ?? null
      count[event] = (count[event] ?? 0) + 1
    }
  }
  const names = Object.keys(first).sort()
  assert.ok(names.length >= 20, `only ${names.length} kinds of event`)
  assert.equal(snapshot("07-live-events", { status: 200, body: Object.fromEntries(names.map((n) => [n, first[n]])) }), null)
  // Everyone in the household room hears household writes.
  assert.ok(ctx.leoSocket.events.some((e) => e.event === "lists:updated"))
})
