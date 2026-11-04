// harness.mjs — boots a throwaway central (with its own Postgres) and a hub in
// a temporary HOME, on free ports, and gives tests a way to talk to them.
//
// The hub is started with HUB_BIN or HUB_CMD (default: this Node hub via
// ts-node), so the same suite runs against the Rust hub
// (docs/hub-rust-port-plan.md):
//   HUB_BIN=../src-tauri/target/debug/solora-hub npm run test:contract
// The command gets HOME, SOLORA_PORT, CENTRAL_API_URL and CENTRAL_SOCKET_URL.
//
// HUB_DEVICE=1 runs the story against the hub inside the kiosk app on the
// connected emulator/panel instead (chapter 6's new hub still runs here):
//   - the app is built for it:
//       SOLORA_HUB_CENTRAL_URL=http://localhost:4290 SOLORA_HUB_NAME="Contract Hub" \
//       SOLORA_HUB_OWNER_EMAIL=owner@family.test scripts/android-dev.sh
//     and `adb reverse` takes port 4290 to this run's central
//   - `adb forward` is the hub's own screen (it arrives on the device's loopback)
//   - the emulator's redirect (`adb emu redir`) is a phone on the Wi-Fi
//   - the app's own hub data is set aside first and put back afterwards

import { spawn, execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { io } from "socket.io-client"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.resolve(HERE, "../..")
const CENTRAL = path.resolve(SERVER, "../../central")

/** Shared state the area files fill in as the family story goes on. */
export const ctx = {}
const procs = []

// ── The hub on a device (HUB_DEVICE=1) ──────────────────────────────────────
const DEVICE = !!process.env.HUB_DEVICE
const PKG = "com.peakl.lumora_kiosk"
const DEVICE_CENTRAL_PORT = 4290
const ADB = process.env.ADB ?? path.join(os.homedir(), "Library/Android/sdk/platform-tools/adb")
const adb = (...args) => execFileSync(ADB, args, { encoding: "utf8" }).trim()
/** A shell line run as the app (`run-as`), for its private files. */
const asApp = (line) => adb("shell", "run-as", PKG, "sh", "-c", `'${line}'`)

/** Stops the app (Android starts it again at once: it's the home screen). */
function restartApp() {
  const pid = adb("shell", "pidof", PKG)
  if (pid) asApp(`kill ${pid}`)
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
    s.on("error", reject)
  })
}

/** First non-internal IPv4 address: requests to it don't count as "from the hub". */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address
  }
  return null
}

function start(name, cmd, args, opts) {
  const log = fs.openSync(path.join(ctx.dir, `${name}.log`), "a")
  const p = spawn(cmd, args, { ...opts, stdio: ["ignore", log, log], detached: true })
  p.on("error", (e) => fs.appendFileSync(path.join(ctx.dir, `${name}.log`), `[harness] couldn't start ${cmd}: ${e.message}\n`))
  procs.push(p)
  return p
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error(`${url} never came up (logs in ${ctx.dir})`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

export async function boot() {
  // Short path: Postgres caps its socket path, and we keep it TCP-only anyway.
  ctx.dir = fs.mkdtempSync(path.join("/tmp", "solora-contract-"))
  const env = { ...process.env, LC_ALL: "en_US.UTF-8" }

  // ── Postgres + central ────────────────────────────────────────────────────
  const pgPort = await freePort()
  const pgData = path.join(ctx.dir, "pg")
  execFileSync("initdb", ["-D", pgData, "-U", "postgres", "-A", "trust"], { env, stdio: "ignore" })
  fs.appendFileSync(path.join(pgData, "postgresql.conf"),
    `\nport = ${pgPort}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = ''\n`)
  execFileSync("pg_ctl", ["-D", pgData, "-l", path.join(ctx.dir, "pg.log"), "-w", "start"], { env, stdio: "ignore" })
  ctx.pgData = pgData
  execFileSync("createdb", ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "postgres", "central"], { env })

  const centralPort = DEVICE ? DEVICE_CENTRAL_PORT : await freePort()
  ctx.centralUrl = `http://127.0.0.1:${centralPort}`
  const centralEnv = {
    ...env,
    DATABASE_URL: `postgres://postgres@127.0.0.1:${pgPort}/central`,
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    ADMIN_API_KEY: crypto.randomBytes(24).toString("hex"),
    API_PORT: String(centralPort),
    SOCKET_PORT: String(centralPort),
    NODE_ENV: "test",
  }
  ctx.adminKey = centralEnv.ADMIN_API_KEY
  const tsNode = (dir) => path.join(dir, "node_modules/.bin/ts-node")
  execFileSync(tsNode(CENTRAL), ["--transpile-only", "src/db/migrate-cli.ts"], { cwd: CENTRAL, env: centralEnv, stdio: "ignore" })
  start("central", tsNode(CENTRAL), ["--transpile-only", "src/index.ts"], { cwd: CENTRAL, env: centralEnv })
  await waitFor(`${ctx.centralUrl}/health`)

  // ── Hub ───────────────────────────────────────────────────────────────────
  ctx.lan = lanAddress()
  const first = DEVICE ? await startDeviceHub() : await startHub("hub")
  Object.assign(ctx, { home: first.home, hubUrl: first.url, lanHubUrl: first.lanUrl })
}

/**
 * Starts a hub with its own HOME on a free port and waits until it's
 * registered with central. The story's hub is "hub"; chapter 6 starts a
 * second, unclaimed one to move the family into.
 */
export async function startHub(name) {
  const env = { ...process.env, LC_ALL: "en_US.UTF-8" }
  const tsNode = (dir) => path.join(dir, "node_modules/.bin/ts-node")
  const hubPort = await freePort()
  const home = path.join(ctx.dir, `${name}-home`)
  fs.mkdirSync(home)
  const url = `http://127.0.0.1:${hubPort}`
  const lanUrl = ctx.lan ? `http://${ctx.lan}:${hubPort}` : null
  const hubEnv = {
    ...env,
    HOME: home,
    SOLORA_PORT: String(hubPort),
    CENTRAL_API_URL: ctx.centralUrl,
    CENTRAL_SOCKET_URL: ctx.centralUrl,
    HUB_NAME: "Contract Hub",
    HUB_OWNER_EMAIL: "owner@family.test",
    SOLORA_MDNS: "off",
    // Keep the developer's kiosk/server/.env out of it (dotenv never overrides).
    GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "",
    MICROSOFT_CLIENT_ID: "", MICROSOFT_CLIENT_SECRET: "", MICROSOFT_TENANT_ID: "common",
  }
  // HUB_BIN is one executable (paths with spaces are fine); HUB_CMD is split
  // on spaces; the default isn't split, since this repo's path has some.
  // NEW_HUB_BIN runs chapter 6's new hub differently ("" = the Node hub), to
  // move a family between the Node and Rust hubs.
  const bin = name === "hub2" && process.env.NEW_HUB_BIN !== undefined ? process.env.NEW_HUB_BIN : process.env.HUB_BIN
  const [cmd, ...args] = bin
    ? [bin]
    : process.env.HUB_CMD && !(name === "hub2" && process.env.NEW_HUB_BIN !== undefined)
      ? process.env.HUB_CMD.split(" ")
      : [tsNode(SERVER), "--transpile-only", "src/index.ts"]
  start(name, cmd, args, { cwd: SERVER, env: hubEnv })
  await waitFor(`${url}/health`)
  // Registration with central happens right after listen; wait for it.
  const file = path.join(home, ".lumora", "central.json")
  for (let i = 0; i < 80 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 250))
  return { url, lanUrl, home, port: hubPort }
}

/** A fresh hub inside the app on the device, on this run's central. */
async function startDeviceHub() {
  const forward = await freePort()
  const redirect = await freePort()
  adb("reverse", `tcp:${DEVICE_CENTRAL_PORT}`, `tcp:${DEVICE_CENTRAL_PORT}`)
  adb("forward", `tcp:${forward}`, "tcp:4000")
  adb("emu", "redir", "add", `tcp:${redirect}:4000`)
  ctx.device = { forward, redirect, aside: `hub-before-contract-${Date.now()}` }
  asApp(`if [ -d hub ]; then mv hub ${ctx.device.aside}; fi`)
  restartApp()
  const url = `http://127.0.0.1:${forward}`
  await new Promise((r) => setTimeout(r, 2000))
  await waitFor(`${url}/health`)
  for (let i = 0; i < 80; i++) {
    try { centralFile(); break } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  return { url, lanUrl: `http://127.0.0.1:${redirect}`, home: null, port: 4000 }
}

/** Puts the app's own hub data back and undoes the port mappings. */
function stopDeviceHub() {
  if (!ctx.device) return
  const { forward, redirect, aside } = ctx.device
  try {
    asApp(`rm -r hub; if [ -d ${aside} ]; then mv ${aside} hub; fi`)
    restartApp()
  } catch (e) { console.error(`[harness] couldn't put the app's hub back (${aside}): ${e.message}`) }
  for (const args of [["forward", "--remove", `tcp:${forward}`], ["emu", "redir", "del", `tcp:${redirect}`], ["reverse", "--remove", `tcp:${DEVICE_CENTRAL_PORT}`]]) {
    try { adb(...args) } catch { /* already gone */ }
  }
}

/** What the hub keeps about central in its HOME (hub id, per-display central ids). */
export function centralFile(home = ctx.home) {
  if (DEVICE && home === ctx.home) return JSON.parse(asApp("cat hub/central.json"))
  return JSON.parse(fs.readFileSync(path.join(home, ".lumora", "central.json"), "utf8"))
}

/**
 * A plain web server on the LAN address serving `routes` ({ path: body }), for
 * calendar links: the hub won't fetch from localhost. Null without a LAN address.
 */
export async function lanServer(routes) {
  if (!ctx.lan) return null
  const { createServer } = await import("node:http")
  const server = createServer((req, res) => {
    const body = routes[req.url]
    if (body === undefined) { res.writeHead(404).end("nope"); return }
    res.writeHead(200, { "Content-Type": "text/calendar" }).end(typeof body === "function" ? body() : body)
  })
  await new Promise((r) => server.listen(0, "0.0.0.0", r))
  servers.push(server)
  return `http://${ctx.lan}:${server.address().port}`
}
const servers = []

export async function shutdown() {
  stopDeviceHub()
  for (const s of sockets.splice(0)) s.close()
  for (const s of servers.splice(0)) s.close()
  for (const p of procs.splice(0)) {
    try { process.kill(-p.pid, "SIGTERM") } catch { /* gone */ }
  }
  await new Promise((r) => setTimeout(r, 300))
  try {
    execFileSync("pg_ctl", ["-D", ctx.pgData, "-m", "immediate", "stop"], { env: { ...process.env, LC_ALL: "en_US.UTF-8" }, stdio: "ignore" })
  } catch { /* already down */ }
  if (!process.env.KEEP_CONTRACT_DIR) fs.rmSync(ctx.dir, { recursive: true, force: true })
  else console.log(`contract dir kept: ${ctx.dir}`)
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

/**
 * Calls the hub. `lan: true` goes through the LAN address, so the hub sees a
 * phone on the Wi-Fi rather than its own screen (lib/loopback.ts).
 */
export async function hub(method, urlPath, { token, body, lan = false, headers = {}, raw = false, base: at } = {}) {
  const base = at ?? (lan ? ctx.lanHubUrl : ctx.hubUrl)
  if (!base) throw new Error("no LAN address on this machine")
  const res = await fetch(base + urlPath, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  if (raw) return res
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json, headers: res.headers }
}

export async function central(method, urlPath, { token, body, admin = false } = {}) {
  const res = await fetch(ctx.centralUrl + urlPath, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(admin ? { "X-Admin-Key": ctx.adminKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json }
}

/** A Solora account at central; returns its access token. */
export async function signup(email, name, password = "correct horse battery") {
  const r = await central("POST", "/auth/signup", { body: { email, name, password } })
  if (r.status !== 201) throw new Error(`signup ${email}: ${r.status} ${JSON.stringify(r.body)}`)
  return r.body.access_token
}

// ── Socket.IO ────────────────────────────────────────────────────────────────

const sockets = []

/** A hub socket that records every event it receives. */
export async function listen(token) {
  const s = io(ctx.hubUrl, { auth: { token }, transports: ["websocket"], reconnection: false })
  s.events = []
  s.onAny((event, payload) => s.events.push({ event, payload }))
  sockets.push(s)
  await new Promise((resolve, reject) => {
    s.once("connect", resolve)
    s.once("connect_error", reject)
  })
  return s
}

/** Runs fn, then returns the event names the socket saw while it ran. */
export async function broadcasts(socket, fn, settleMs = 150) {
  const from = socket.events.length
  const result = await fn()
  await new Promise((r) => setTimeout(r, settleMs))
  return { result, events: socket.events.slice(from).map((e) => e.event) }
}

// ── Snapshots ────────────────────────────────────────────────────────────────

const SNAP_DIR = path.join(HERE, "__snapshots__")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const JWT = /^ey[\w-]+\.[\w-]+\.[\w-]+$/
const UUID_IN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
/** Today's date in the zones the hub might call home (chores stamp it). */
const TODAY = new Set(["America/Chicago", "UTC", Intl.DateTimeFormat().resolvedOptions().timeZone].map((timeZone) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())))
/** Fields that are random on every run (codes people type), masked by name. */
const RANDOM_KEYS = new Set(["pairing_code", "setupCode", "code", "invite_code", "ticket", "hubUrl", "token", "refreshToken", "lanUrl", "url", "webcalUrl", "data"])

/**
 * A list in a fixed order, for lists the hub orders by a timestamp that ties
 * within a second: by `key`, then by content with its ids masked.
 */
export function sortList(list, key) {
  const content = (item) => JSON.stringify(shape(item, new Map()))
  return [...list].sort((a, b) => String(a[key]).localeCompare(String(b[key])) || content(a).localeCompare(content(b)))
}

/** A response with its list body in a fixed order (see sortList). */
export function sortedBy(r, key) {
  return { ...r, body: sortList(r.body, key) }
}

/**
 * The shape of a response with the per-run values (ids, times, tokens) masked,
 * so two hubs answering the same story produce the same snapshot.
 */
export function shape(value, ids = new Map()) {
  if (Array.isArray(value)) return value.map((v) => shape(v, ids))
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [
      k,
      RANDOM_KEYS.has(k) && typeof value[k] === "string" ? `<${k}>` : shape(value[k], ids),
    ]))
  }
  if (typeof value === "string") {
    if (UUID.test(value)) {
      if (!ids.has(value)) ids.set(value, `<id${ids.size + 1}>`)
      return ids.get(value)
    }
    if (TODAY.has(value)) return "<today>"
    // Ids inside strings ("member:<id>", file names) get the same names.
    if (UUID_IN.test(value)) {
      return value.replace(new RegExp(UUID_IN.source, "gi"), (id) => {
        if (!ids.has(id)) ids.set(id, `<id${ids.size + 1}>`)
        return ids.get(id)
      })
    }
    if (ISO.test(value)) return "<time>"
    if (JWT.test(value)) return "<jwt>"
    if (/^[0-9a-f]{32,}$/i.test(value)) return `<hex${value.length}>`
  }
  if (typeof value === "number" && value > 1_600_000_000_000 && value < 4_000_000_000_000) return "<ms>"
  return value
}

/**
 * Compares a response with __snapshots__/<name>.json; UPDATE_SNAPSHOTS=1
 * writes it instead. Returns a diff message or null.
 */
export function snapshot(name, response) {
  const file = path.join(SNAP_DIR, `${name}.json`)
  const actual = JSON.stringify({ status: response.status, body: shape(response.body) }, null, 2) + "\n"
  if (process.env.UPDATE_SNAPSHOTS || !fs.existsSync(file)) {
    fs.mkdirSync(SNAP_DIR, { recursive: true })
    fs.writeFileSync(file, actual)
    return null
  }
  const expected = fs.readFileSync(file, "utf8")
  if (expected === actual) return null
  // The whole response, for diffing (the assertion message gets cut short).
  if (ctx.dir) {
    fs.mkdirSync(path.join(ctx.dir, "actual"), { recursive: true })
    fs.writeFileSync(path.join(ctx.dir, "actual", `${name}.json`), actual)
  }
  return `snapshot ${name} differs (whole response in ${ctx.dir}/actual/${name}.json):\n--- expected\n${expected}+++ actual\n${actual}`
}
