/**
 * index.ts — Lumora local server entry point.
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

import { getDb, PHOTOS_DIR, ensureDataDir, getOrCreateSecret } from "./db"
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
import { icsRouter } from "./routes/ics"
import { hubCommandRouter } from "./routes/hub-command"
import { startCalendarSyncScheduler } from "./services/calendar-sync"
import { ensureCentralRegistration } from "./lib/central-registry"
import { connectHubToCentral, isCentralConnected } from "./lib/central-socket-client"

import type { ServerToClientEvents, ClientToServerEvents, SocketData } from "./types"

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

ensureDataDir()
getOrCreateSecret() // generate HMAC secret on first boot
getDb()             // open DB and run schema migration
startCalendarSyncScheduler() // hourly Google / Microsoft calendar sync
// OTA catch-up for devices that were offline at push time is handled by the kiosk
// frontend itself (GET /devices/ota/check on central-socket connect/reconnect) — see
// lumora_kiosk/src/lib/central-socket.ts. A hub-side relay used to exist here but the
// central socket server intentionally blocks hub-injected `ota:push` (security boundary
// in lumora_central_socket_io/src/events/hub.ts), so it never delivered anything and
// falsely marked jobs "acknowledged" before the kiosk received them.

const PORT = Number(process.env.LUMORA_PORT ?? 4000)

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express()

// Security headers
app.use(helmet())

// CORS — restrict to known local origins (Tauri webview + Vite dev server).
// Additional origins can be added via ALLOWED_ORIGINS env var (comma-separated).
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:1420",
  "http://localhost:1422",
  ...(process.env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
]
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
)

// Auth rate limiting — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
})

app.use(express.json({ limit: "2mb" }))
app.use(express.urlencoded({ extended: true }))

// Serve photo files as authenticated static files.
// We handle auth manually here so we can validate the Bearer token.
app.use(
  "/photo-files",
  (req: Request, res: Response, next: NextFunction) => {
    // Allow token in query string for <img> tags that can't set headers.
    const token =
      (req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : undefined) ??
      (typeof req.query.token === "string" ? req.query.token : undefined)
    if (!token) {
      res.status(401).json({ error: "Unauthorized." })
      return
    }
    try {
      const { verifyToken } = require("./middleware/auth") as typeof import("./middleware/auth")
      verifyToken(token)
      next()
    } catch {
      res.status(401).json({ error: "Invalid or expired token." })
    }
  },
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
app.use("/api/v1/hub", hubCommandRouter)
app.use("/ics", icsRouter)

// Health check — returns minimal info to avoid leaking version/env details
app.get("/health", (_req, res) => {
  res.json({ status: "ok" })
})

// Central hub identity — requires auth so only provisioned clients can read hub_id.
app.get("/central-identity", requireAuth, (_req: Request, res: Response) => {
  const creds = (() => {
    try {
      const p = path.join(process.env.HOME ?? ".", ".lumora", "central.json")
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
      const p = path.join(process.env.HOME ?? ".", ".lumora", "central.json")
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

// ---------------------------------------------------------------------------
// HTTP server + Socket.IO
// ---------------------------------------------------------------------------

const httpServer = createServer(app)

const io = new SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>(httpServer, {
  cors: {
    origin: allowedOrigins,
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
    if (hubJwt) connectHubToCentral(hubJwt)
  })
  .catch((err: unknown) => {
    console.warn("[central] Registration error:", (err as Error).message)
  })

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[lumora] Server listening on http://0.0.0.0:${PORT}`)
  console.log(`[lumora] API base: http://0.0.0.0:${PORT}/api/v1`)
})

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[lumora] SIGTERM received — shutting down")
  httpServer.close(() => {
    getDb().close()
    process.exit(0)
  })
})

process.on("SIGINT", () => {
  console.log("[lumora] SIGINT received — shutting down")
  httpServer.close(() => {
    getDb().close()
    process.exit(0)
  })
})
