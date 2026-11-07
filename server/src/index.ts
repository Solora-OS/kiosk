/**
 * index.ts — Solora local server entry point.
 *
 * Starts Express + Socket.IO on PORT (default 4000).
 * Binds to 0.0.0.0 so the API is reachable from phones/tablets on the LAN.
 * All routes require a valid HS256 JWT (except /auth/register and /auth/login).
 * Every DB write broadcasts a Socket.IO event to the household room.
 */

import path from "path"
import dotenv from "dotenv"
dotenv.config({ path: path.resolve(__dirname, "../.env") })
import express, { type Request, type Response, type NextFunction } from "express"
import { createServer } from "http"
import { Server as SocketIOServer } from "socket.io"
import cors from "cors"
import helmet from "helmet"
import rateLimit from "express-rate-limit"

import { getDb, DATA_DIR, PHOTOS_DIR, ensureDataDir, getOrCreateSecret } from "./db"
import { setBroadcaster } from "./broadcaster"
import { socketAuth, requireAuth } from "./middleware/auth"

import { authRouter } from "./routes/auth"
import { membersRouter } from "./routes/members"
import { invitesRouter } from "./routes/invites"
import { calendarsRouter } from "./routes/calendars"
import { eventsRouter } from "./routes/events"
import { choresRouter } from "./routes/chores"
import { listsRouter } from "./routes/lists"
import { mealsRouter } from "./routes/meals"
import { notificationsRouter } from "./routes/notifications"
import { photosRouter } from "./routes/photos"
import { snapshotRouter } from "./routes/snapshot"
import { kioskRouter } from "./routes/kiosk"
import { calendarProvidersRouter } from "./routes/calendar-providers"
import { activityLogsRouter } from "./routes/activity-logs"
import { supportRouter } from "./routes/support"
import { icsLinkRouter, icsRouter } from "./routes/ics"
import { hubCommandRouter } from "./routes/hub-command"
import { wallRouter } from "./routes/wall"
import { hubInfoRouter } from "./routes/hub"
import { transferRouter } from "./routes/transfer"
import { rewardsRouter } from "./routes/rewards"
import { awayRouter } from "./routes/away"
import { homeRouter } from "./routes/home"
import { getOrCreateSetupCode } from "./lib/setup-code"
import { startCalendarSyncScheduler } from "./services/calendar-sync"
import { fromThisHub } from "./lib/loopback"
import { startReminderScheduler } from "./services/reminders"
import { startCalendarLinkScheduler } from "./services/calendar-links"
import { calendarLinksRouter } from "./routes/calendar-links"
import { seasonsRouter } from "./routes/seasons"
import { summerRouter } from "./routes/summer"
import { ensureCentralRegistration } from "./lib/central-registry"
import { registerReusableInvites } from "./services/invite-relay"
import { connectHubToCentral, isCentralConnected } from "./lib/central-socket-client"
import { startMdnsAdvertisement, stopMdnsAdvertisement } from "./lib/mdns-advertise"

import type { ServerToClientEvents, ClientToServerEvents, SocketData } from "./types"

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

ensureDataDir()
getOrCreateSecret() // generate HMAC secret on first boot
getDb()             // open DB and run schema migration
startCalendarSyncScheduler() // hourly Google / Microsoft calendar sync
startReminderScheduler() // event reminders, checked every minute
startCalendarLinkScheduler() // iCal links (school, league), re-read hourly
// OTA catch-up for devices that were offline at push time is handled by the kiosk
// frontend itself (GET /devices/ota/check on central-socket connect/reconnect) — see
// kiosk/src/lib/central-socket.ts. A hub-side relay used to exist here but the
// central socket server intentionally blocks hub-injected `ota:push` (security boundary
// in central/src/realtime), so it never delivered anything and
// falsely marked jobs "acknowledged" before the kiosk received them.

const PORT = Number(process.env.SOLORA_PORT ?? 4000)

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()

// Security headers. CORP is relaxed to cross-origin because every client is a
// webview on another origin (tauri://localhost, a dev port, a phone) loading
// <img src="/photo-files/…">; the default same-origin policy makes WebKit drop
// those images. Photo files are still gated by the token check below.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }))

// CORS — this API is reached by kiosk/mobile Tauri webviews over the LAN,
// whose origin (a custom scheme like tauri://localhost, or a bare LAN IP)
// can never be known ahead of time and isn't a fixed dev-server port. All
// auth here is Bearer-token/body-token (no cookies anywhere in this server —
// see middleware/auth.ts), so there is no cookie-based CSRF surface for CORS
// to protect against; trusting the reflected origin is safe. `credentials:
// true` only enables the Authorization header for cross-origin requests, not
// cookies.
app.use(
  cors({
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)

// Auth rate limiting — 10 sign-in attempts per 15 minutes per IP. Only attempts
// count: checking an existing session (GET /auth/me) needs a valid signed token
// already, and the hub's own screen (same machine) reloads freely. Counting
// those let a few wall reloads lock the wall out on "Loading".
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.method === "GET" || fromThisHub(req),
  message: { error: "Too many login attempts. Please try again later." },
})

// The photo relay upload (POST /photos/base64) carries an image as base64,
// which is ~33% larger than the raw bytes. The route caps the decoded image at
// 3 MB, so this parser must admit the ~4 MB of JSON that produces — the global
// 2 MB limit below would reject a valid photo first. express.json marks the
// body parsed, so the global parser skips it for this path.
app.use(["/api/v1/photos", "/api/v1/photos/base64"], express.json({ limit: "5mb" }))
app.use(express.json({ limit: "2mb" }))
app.use(express.urlencoded({ extended: true }))

// Serve photo files as authenticated static files. Same check as the API
// (hub device tokens and central account tokens alike); a ?token= query is
// promoted to the header for <img> tags that can't set one.
app.use(
  "/photo-files",
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.headers.authorization && typeof req.query.token === "string") {
      req.headers.authorization = `Bearer ${req.query.token}`
    }
    next()
  },
  requireAuth,
  express.static(PHOTOS_DIR, { maxAge: "1d", etag: true }),
)

// API routes — auth endpoints are rate-limited
app.use("/api/v1/auth", authLimiter, authRouter)
app.use("/api/v1/members", membersRouter)
app.use("/api/v1/invites", invitesRouter)
app.use("/api/v1/calendars", calendarsRouter)
app.use("/api/v1/events", eventsRouter)
app.use("/api/v1/chores", choresRouter)
app.use("/api/v1/lists", listsRouter)
app.use("/api/v1/meals", mealsRouter)
app.use("/api/v1/notifications", notificationsRouter)
app.use("/api/v1/photos", photosRouter)
app.use("/api/v1/snapshot", snapshotRouter)
app.use("/api/v1/kiosk", kioskRouter)
// Alias used by kiosk-status.ts heartbeat publisher
app.use("/api/v1/kiosk-devices", kioskRouter)
app.use("/api/v1/calendar-providers", calendarProvidersRouter)
app.use("/api/v1/activity-logs", activityLogsRouter)
app.use("/api/v1/support", supportRouter)
app.use("/api/v1/hub", hubCommandRouter)
app.use("/api/v1/hub", hubInfoRouter)
app.use("/api/v1/wall", wallRouter)
app.use("/api/v1/transfer", transferRouter)
app.use("/api/v1/rewards", rewardsRouter)
app.use("/api/v1/away", awayRouter)
app.use("/api/v1/home", homeRouter)
app.use("/api/v1/calendar-links", calendarLinksRouter)
app.use("/api/v1/seasons", seasonsRouter)
app.use("/api/v1/summer", summerRouter)
app.use("/ics", icsRouter)
app.use("/api/v1/ics-link", icsLinkRouter)

// Health check — returns minimal info to avoid leaking version/env details
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

// Central hub identity — requires auth so only provisioned clients can read hub_id.
app.get("/central-identity", requireAuth, (_req: Request, res: Response) => {
  const creds = (() => {
    try {
      const p = path.join(DATA_DIR, "central.json")
      return JSON.parse(require("fs").readFileSync(p, "utf-8")) as { hub_id: string }
    } catch { return null }
  })()
  if (!creds) {
    res.status(503).json({ error: "Hub not yet registered with central API — retry in a few seconds" })
    return
  }
  res.json({ hub_id: creds.hub_id })
})

// Connection health — requires auth. Returns connectivity + registration status.
app.get("/connection-health", requireAuth, async (_req: Request, res: Response) => {
  const CENTRAL_API_URL    = process.env.CENTRAL_API_URL    ?? "http://localhost:4000"
  const CENTRAL_SOCKET_URL = process.env.CENTRAL_SOCKET_URL ?? "http://localhost:5001"

  // ── Central registry credentials ─────────────────────────────────────────
  const creds = (() => {
    try {
      const p = path.join(DATA_DIR, "central.json")
      return JSON.parse(require("fs").readFileSync(p, "utf-8")) as {
        hub_id: string; hub_token: string; hub_jwt: string
        kiosks: Record<string, { central_device_id: string; central_jwt: string }>
      }
    } catch { return null }
  })()

  // ── Ping central API ──────────────────────────────────────────────────────
  const centralApiPing = await (async () => {
    try {
      const r = await fetch(`${CENTRAL_API_URL}/health`, { signal: AbortSignal.timeout(3000) })
      return { ok: r.ok, status: r.status }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })()

  // ── Ping central socket health endpoint ──────────────────────────────────
  const centralSocketPing = await (async () => {
    try {
      const r = await fetch(`${CENTRAL_SOCKET_URL}/health`, { signal: AbortSignal.timeout(3000) })
      return { ok: r.ok, status: r.status }
    } catch (e) { return { ok: false, error: (e as Error).message } }
  })()

  // ── Paired kiosk devices ──────────────────────────────────────────────────
  const db = getDb()
  const kiosks = (db.prepare(
    "SELECT id, device_name, household_id FROM kiosk_devices"
  ).all() as Array<{ id: string; device_name: string; household_id: string | null }>)
    .map((k) => ({
      local_device_id:    k.id,
      device_name:        k.device_name,
      paired:             !!k.household_id,
      central_registered: !!(creds?.kiosks?.[k.id]),
      central_device_id:  creds?.kiosks?.[k.id]?.central_device_id ?? null,
      has_central_jwt:    !!(creds?.kiosks?.[k.id]?.central_jwt),
    }))

  res.json({
    ts:  new Date().toISOString(),

    hub: {
      registered_with_central: !!creds,
      hub_id:                  creds?.hub_id ?? null,
      central_socket_connected: isCentralConnected(),
    },

    central_api: {
      url:  CENTRAL_API_URL,
      ...centralApiPing,
    },

    central_socket: {
      url:  CENTRAL_SOCKET_URL,
      ...centralSocketPing,
    },

    kiosks,

    next_steps: [
      ...(!creds                      ? ["Hub not registered with central API — check CENTRAL_API_URL in server/.env and restart hub"] : []),
      ...(!isCentralConnected()       ? ["Hub not connected to central socket — check CENTRAL_SOCKET_URL and hub JWT"] : []),
      ...(!centralApiPing.ok          ? [`Central API unreachable at ${CENTRAL_API_URL}`] : []),
      ...(!centralSocketPing.ok       ? [`Central socket unreachable at ${CENTRAL_SOCKET_URL}`] : []),
      ...(kiosks.filter(k => k.paired && !k.central_registered).map(k =>
        `Kiosk "${k.device_name}" (${k.local_device_id}) is paired locally but not registered with central — hub will register on next restart`
      )),
    ],
  })
})

// 404 catch-all
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found." })
})

// Error handler — keeps body-parser failures (and anything a route throws) in
// the app's JSON error shape instead of Express's default HTML page. An
// oversize upload becomes a friendly 413 rather than a PayloadTooLargeError
// page the apps can't read.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return
  if (err?.type === "entity.too.large" || err?.status === 413) {
    res.status(413).json({ error: "That upload is too large." })
    return
  }
  if (err?.type === "entity.parse.failed" || err?.status === 400) {
    res.status(400).json({ error: "That request wasn't valid JSON." })
    return
  }
  console.error("[solora] Unhandled error:", err)
  res.status(500).json({ error: "Something went wrong." })
})

// ---------------------------------------------------------------------------
// HTTP server + Socket.IO
// ---------------------------------------------------------------------------

const httpServer = createServer(app)

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
  cors: {
    // Same reasoning as the Express CORS config above — no cookies, socket
    // auth is a bearer token in handshake.auth, so trusting the origin is safe.
    origin: true,
    credentials: true,
    methods: ["GET", "POST"],
  },
  // Allow clients to reconnect after brief network drops.
  pingTimeout: 30_000,
  pingInterval: 10_000,
})

// Authenticate every socket connection.
io.use(socketAuth)

io.on("connection", (socket) => {
  const { userId, householdId, name } = socket.data

  // Join the household-scoped room so broadcasts are scoped.
  const room = `household:${householdId}`
  void socket.join(room)

  console.log(`[socket] ${name} (${userId}) connected — joined ${room}`)

  socket.on("disconnect", (reason) => {
    console.log(`[socket] ${name} (${userId}) disconnected — ${reason}`)
  })
})

// Wire up the broadcaster so routes can call broadcast().
setBroadcaster(io)

// Register with the central API and connect to the central socket.
// Runs asynchronously — hub works fully offline if central is unreachable.
ensureCentralRegistration()
  .then((hubJwt) => {
    if (!hubJwt) return
    connectHubToCentral(hubJwt)
    registerReusableInvites()
  })
  .catch((err: unknown) => {
    console.warn("[central] Registration error:", (err as Error).message)
  })

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[solora] Server listening on http://0.0.0.0:${PORT}`)
  console.log(`[solora] API base: http://0.0.0.0:${PORT}/api/v1`)
  startMdnsAdvertisement(PORT)
  // A new hub shows its setup code on screen from first boot.
  const { n } = getDb().prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  if (n === 0) getOrCreateSetupCode()
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[solora] SIGTERM received — shutting down")
  stopMdnsAdvertisement()
  httpServer.close(() => {
    getDb().close()
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("[solora] SIGINT received — shutting down")
  stopMdnsAdvertisement()
  httpServer.close(() => {
    getDb().close()
    process.exit(0)
  })
})
