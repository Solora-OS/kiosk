// Chapter 1 — unboxing: the hub's own screen, the setup code, the first
// owner, a stranger who can't take over, and a second display.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ctx, hub, signup, listen, broadcasts, snapshot } from "../harness.mjs"

const same = (name, r) => assert.equal(snapshot(name, r), null)

test("unboxed hub: unclaimed, its own screen registers without pairing", async () => {
  const info = await hub("GET", "/api/v1/hub/info")
  assert.equal(info.status, 200)
  assert.equal(info.body.claimed, false)
  assert.equal(info.body.name, "Contract Hub")
  same("01-hub-info-unclaimed", info)

  const reg = await hub("POST", "/api/v1/kiosk/register", { body: { device_name: "Kitchen Wall" } })
  assert.equal(reg.status, 201)
  assert.match(reg.body.pairing_code, /^\d{6}$/, "no household yet, so even the hub's screen gets a code")
  same("01-kiosk-register-on-hub", reg)
  ctx.wallToken = reg.body.device_token
  ctx.wallId = reg.body.id

  const state = await hub("GET", "/api/v1/kiosk/state", { token: ctx.wallToken })
  assert.equal(state.body.paired, false)
  same("01-kiosk-state-unpaired", state)
})

test("the setup code is only shown on the hub itself", async () => {
  if (ctx.lanHubUrl) {
    const lan = await hub("GET", "/api/v1/hub/setup", { lan: true })
    assert.equal(lan.status, 403)
    same("01-hub-setup-from-lan", lan)
  }
  const local = await hub("GET", "/api/v1/hub/setup")
  assert.equal(local.status, 200)
  assert.match(local.body.setupCode, /^[0-9A-F]{8}$/)
  ctx.setupCode = local.body.setupCode
  same("01-hub-setup", { ...local, body: { ...local.body, setupCode: "<code>", hubUrl: "<url>" } })
})

test("first owner claims the hub with the setup code", async () => {
  ctx.mayaAccount = await signup("maya@family.test", "Maya")

  const none = await hub("POST", "/api/v1/auth/session", { body: {} })
  assert.equal(none.status, 400)
  same("01-session-no-token", none)

  const bad = await hub("POST", "/api/v1/auth/session", { body: { access_token: "nope", setupCode: ctx.setupCode } })
  assert.equal(bad.status, 401)
  same("01-session-bad-token", bad)

  const wrong = await hub("POST", "/api/v1/auth/session", { body: { access_token: ctx.mayaAccount, setupCode: "00000000" } })
  assert.equal(wrong.status, 403)
  same("01-session-wrong-code", wrong)

  // Typed sloppily: lower case with a dash still matches.
  const typed = ctx.setupCode.toLowerCase().replace(/^(.{4})/, "$1-")
  const ok = await hub("POST", "/api/v1/auth/session", {
    body: { access_token: ctx.mayaAccount, setupCode: typed, household_name: "The Okafor-Reyes Family" },
  })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.equal(ok.body.household.name, "The Okafor-Reyes Family")
  assert.match(ok.body.remoteKey, /^[0-9a-f]{64}$/)
  same("01-session-claim", ok)
  ctx.householdId = ok.body.household.id
  ctx.mayaUserId = ok.body.user.id
  ctx.remoteKey = ok.body.remoteKey

  // Signing in again later needs no code.
  const again = await hub("POST", "/api/v1/auth/session", { body: { access_token: ctx.mayaAccount } })
  assert.equal(again.status, 200)
  assert.equal(again.body.household.id, ctx.householdId)
})

test("a stranger with a valid account can't take over a claimed hub", async () => {
  const stranger = await signup("stranger@elsewhere.test", "Stranger")
  const r = await hub("POST", "/api/v1/auth/session", { body: { access_token: stranger, setupCode: ctx.setupCode } })
  assert.equal(r.status, 409)
  same("01-session-stranger", r)

  const setup = await hub("GET", "/api/v1/hub/setup")
  assert.equal(setup.status, 409)
  same("01-hub-setup-after-claim", setup)

  const info = await hub("GET", "/api/v1/hub/info")
  assert.equal(info.body.claimed, true)
})

test("sessions: account, the hub's screen, auto-login, device refresh", async () => {
  ctx.mayaSocket = await listen(ctx.mayaAccount)

  const me = await hub("GET", "/api/v1/auth/me", { token: ctx.mayaAccount })
  assert.equal(me.status, 200)
  same("01-auth-me-account", me)

  const wall = await hub("GET", "/api/v1/auth/session", { token: ctx.wallToken })
  assert.equal(wall.body.isKiosk, true)
  assert.equal(wall.body.household.id, ctx.householdId, "the hub's own screen joined the new household")
  same("01-auth-session-wall", wall)

  same("01-kiosk-state-paired", await hub("GET", "/api/v1/kiosk/state", { token: ctx.wallToken }))
  same("01-kiosk-autologin-off", await hub("POST", "/api/v1/auth/kiosk-autologin", { body: {} }))
  same("01-device-refresh-missing", await hub("POST", "/api/v1/auth/device-refresh", { body: {} }))
  same("01-device-refresh-bad", await hub("POST", "/api/v1/auth/device-refresh", { body: { refresh_token: "x.y.z" } }))
  // An access token is not a refresh token.
  same("01-device-refresh-access-token", await hub("POST", "/api/v1/auth/device-refresh", { body: { refresh_token: ctx.wallToken } }))
})

test("errors: no token, bad token, unknown route, broken JSON", async () => {
  same("01-no-auth", await hub("GET", "/api/v1/members"))
  same("01-bad-auth", await hub("GET", "/api/v1/members", { token: "abc" }))
  same("01-not-found", await hub("GET", "/api/v1/nope"))
  const r = await fetch(`${ctx.hubUrl}/api/v1/kiosk/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" })
  same("01-broken-json", { status: r.status, body: await r.json() })
  same("01-health", await hub("GET", "/health"))
})

test("a second display pairs with its code, reports in, and can be removed", async () => {
  const reg = await hub("POST", "/api/v1/kiosk/register", { lan: !!ctx.lanHubUrl, body: { device_name: "Hallway" } })
  assert.equal(reg.status, 201)
  ctx.hallToken = reg.body.device_token
  ctx.hallId = reg.body.id
  assert.match(reg.body.pairing_code, /^\d{6}$/)

  same("01-claim-missing-code", await hub("POST", "/api/v1/kiosk/claim", { token: ctx.mayaAccount, body: {} }))
  same("01-claim-wrong-code", await hub("POST", "/api/v1/kiosk/claim", { token: ctx.mayaAccount, body: { pairing_code: "999999" } }))
  same("01-claim-as-unpaired-display", await hub("POST", "/api/v1/kiosk/claim", { token: ctx.hallToken, body: { pairing_code: reg.body.pairing_code } }))

  const code = reg.body.pairing_code.replace(/^(\d{3})/, "$1 ")
  const claim = await hub("POST", "/api/v1/kiosk/claim", { token: ctx.mayaAccount, body: { pairing_code: code } })
  assert.equal(claim.status, 200)
  same("01-claim", claim)

  same("01-kiosk-setup", await hub("POST", "/api/v1/kiosk/setup", { token: ctx.hallToken, body: { device_name: "Hallway Wall", language: "en", timezone: "America/Chicago" } }))
  same("01-kiosk-state-after-setup", await hub("GET", "/api/v1/kiosk/state", { token: ctx.hallToken }))
  same("01-heartbeat", await hub("POST", "/api/v1/kiosk/heartbeat", { token: ctx.hallToken, body: { wifi_signal: 72, ping_latency_ms: 12, battery_percent: null, device_info: "{\"platform\":\"test\"}" } }))
  same("01-heartbeat-alias", await hub("POST", "/api/v1/kiosk-devices/kiosk-devices/heartbeat", { token: ctx.hallToken, body: { wifi_signal: 70 } }))

  const devices = await hub("GET", "/api/v1/kiosk/devices", { token: ctx.mayaAccount })
  assert.equal(devices.body.length, 2)
  same("01-devices", { ...devices, body: [...devices.body].sort((a, b) => a.device_name.localeCompare(b.device_name)) })

  // Display state: only a paired display, only an object, broadcast to the family.
  same("01-display-state-not-display", await hub("POST", "/api/v1/kiosk/display-state", { token: ctx.mayaAccount, body: { state: {} } }))
  same("01-display-state-not-object", await hub("POST", "/api/v1/kiosk/display-state", { token: ctx.hallToken, body: { state: [1] } }))
  same("01-display-state-too-big", await hub("POST", "/api/v1/kiosk/display-state", { token: ctx.hallToken, body: { state: { x: "a".repeat(9000) } } }))
  const { result, events } = await broadcasts(ctx.mayaSocket, () =>
    hub("POST", "/api/v1/kiosk/display-state", { token: ctx.hallToken, body: { state: { screen: "home", orientation: "landscape" } } }))
  same("01-display-state", result)
  assert.deepEqual(events, ["display:state"])

  same("01-unpair", { ...(await hub("POST", "/api/v1/kiosk/unpair", { token: ctx.hallToken, body: {} })), body: { ok: true, pairing_code: "<code>" } })
  same("01-delete-device-unknown", await hub("DELETE", "/api/v1/kiosk/devices/00000000-0000-4000-8000-000000000000", { token: ctx.mayaAccount }))
  // Re-claim then remove from the family side.
  const st = await hub("GET", "/api/v1/kiosk/state", { token: ctx.hallToken })
  await hub("POST", "/api/v1/kiosk/claim", { token: ctx.mayaAccount, body: { pairing_code: st.body.pairing_code } })
  const del = await hub("DELETE", `/api/v1/kiosk/devices/${ctx.hallId}`, { token: ctx.mayaAccount })
  assert.equal(del.status, 204)
})

test("the hub's link to central: identity, health, display tokens", async () => {
  const id = await hub("GET", "/central-identity", { token: ctx.mayaAccount })
  assert.equal(id.status, 200)
  same("01-central-identity", id)

  const token = await hub("POST", "/api/v1/kiosk/request-central-token", { token: ctx.wallToken, body: {} })
  assert.equal(token.status, 200, JSON.stringify(token.body))
  same("01-request-central-token", token)
  const cached = await hub("GET", `/api/v1/kiosk/central-token/${ctx.wallId}`, { token: ctx.wallToken })
  assert.equal(cached.body.token, token.body.token)
  same("01-central-token-unknown", await hub("GET", "/api/v1/kiosk/central-token/nobody", { token: ctx.wallToken }))

  const health = await hub("GET", "/connection-health", { token: ctx.mayaAccount })
  assert.equal(health.body.hub.registered_with_central, true)
  assert.equal(health.body.central_api.ok, true)
  const masked = { ...health.body, central_api: { ...health.body.central_api, url: "<url>" }, central_socket: { ...health.body.central_socket, url: "<url>" } }
  same("01-connection-health", { status: health.status, body: masked })
})
