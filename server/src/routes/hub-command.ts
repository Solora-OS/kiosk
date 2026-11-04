/**
 * hub-command.ts — Remote hub control endpoints.
 *
 * POST /api/v1/hub/command   — change something on the wall display
 * GET  /api/v1/hub/display   — what each wall display last reported
 *
 * Commands are broadcast to the household as a "hub:command" Socket.IO event;
 * each kiosk applies it locally and reports its new state back through
 * POST /kiosk/display-state, which phones see as "display:state".
 *
 * Only trusted accounts can do this: admins, members given the Hub
 * permission, and the wall itself (see manages()).
 */

import { Router } from "express"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import { getDb } from "../db"
import { manages } from "../lib/household-member"
import type { DisplayState, HubCommand } from "../types"
import { logActivity } from "./activity-logs"

export const hubCommandRouter = Router()

const COMMAND_LABELS: Record<string, string> = {
  restart: "restarted the wall display",
  reload: "reloaded the wall display",
  clear_cache: "cleared the wall display's cache",
  display_sleep: "put the wall display to sleep",
  display_wake: "woke the wall display",
  set_orientation: "rotated the wall display",
  set_theme: "changed the wall display's theme",
}

const VALID_ORIENTATIONS = new Set(["normal", "left", "right", "inverted", "portrait"])
const VALID_THEMES = new Set(["light", "dark", "system"])

const isPercent = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= 100

/** Validates a request body into a command, or returns the error to show. */
function parseCommand(body: Record<string, unknown>): HubCommand | string {
  switch (body.type) {
    case "restart":
    case "reload":
    case "clear_cache":
    case "display_sleep":
    case "display_wake":
      return { type: body.type }
    case "set_orientation":
      if (typeof body.orientation !== "string" || !VALID_ORIENTATIONS.has(body.orientation)) {
        return `Invalid orientation. Must be one of: ${[...VALID_ORIENTATIONS].join(", ")}`
      }
      return { type: "set_orientation", orientation: body.orientation as Extract<HubCommand, { type: "set_orientation" }>["orientation"] }
    case "set_idle_mins": {
      const minutes = body.minutes
      if (minutes !== null && (typeof minutes !== "number" || minutes < 1 || minutes > 60)) {
        return "minutes must be a number 1–60, or null to disable."
      }
      return { type: "set_idle_mins", minutes: minutes as number | null }
    }
    case "set_brightness":
      if (!isPercent(body.level, 5)) return "level must be a number 5–100."
      return { type: "set_brightness", level: Math.round(body.level) }
    case "set_volume":
      if (!isPercent(body.level)) return "level must be a number 0–100."
      return { type: "set_volume", level: Math.round(body.level) }
    case "set_muted":
      if (typeof body.muted !== "boolean") return "muted must be true or false."
      return { type: "set_muted", muted: body.muted }
    case "set_theme":
      if (typeof body.theme !== "string" || !VALID_THEMES.has(body.theme)) return "theme must be light, dark or system."
      return { type: "set_theme", theme: body.theme as "light" | "dark" | "system" }
    case "set_season":
      if (typeof body.mode !== "string" || !/^[a-z0-9-]{1,48}$/.test(body.mode)) return "mode must be \"auto\" or a season id."
      return { type: "set_season", mode: body.mode }
    case "set_season_effects":
      if (typeof body.on !== "boolean") return "on must be true or false."
      return { type: "set_season_effects", on: body.on }
    default:
      return "Unknown command."
  }
}

hubCommandRouter.post("/command", requireAuth, (req, res) => {
  const user = (req as AuthRequest).user
  const householdId = user.householdId
  if (!householdId) {
    res.status(403).json({ error: "Not associated with a household." })
    return
  }
  if (!manages(user, "hub")) {
    res.status(403).json({ error: "Only admins and members with hub access can control the display." })
    return
  }

  const cmd = parseCommand(req.body as Record<string, unknown>)
  if (typeof cmd === "string") {
    res.status(400).json({ error: cmd })
    return
  }

  // Only the commands a family would want to look back on; sliders (volume,
  // brightness) would fill the log with every drag.
  const label = COMMAND_LABELS[cmd.type as string]
  if (label) logActivity(req, { action: "hub.command", resourceType: "hub", resourceName: label, metadata: { type: cmd.type } })
  broadcast(householdId, "hub:command", cmd)
  res.json({ ok: true, command: cmd })
})

hubCommandRouter.get("/display", requireAuth, (req, res) => {
  const user = (req as AuthRequest).user
  if (!user.householdId) {
    res.json({ displays: [] })
    return
  }
  if (!manages(user, "hub")) {
    res.status(403).json({ error: "Only admins and members with hub access can control the display." })
    return
  }

  const rows = getDb()
    .prepare(
      `SELECT id, device_name, display_state, display_state_at, last_heartbeat
       FROM kiosk_devices WHERE household_id = ? ORDER BY last_heartbeat DESC`,
    )
    .all(user.householdId) as {
      id: string
      device_name: string | null
      display_state: string | null
      display_state_at: string | null
      last_heartbeat: string | null
    }[]

  res.json({
    displays: rows.map((r) => {
      let state: DisplayState = {}
      try { state = r.display_state ? (JSON.parse(r.display_state) as DisplayState) : {} } catch { /* keep empty */ }
      return {
        deviceId: r.id,
        name: r.device_name ?? "Solora Display",
        state,
        updatedAt: r.display_state_at,
        lastHeartbeat: r.last_heartbeat,
      }
    }),
  })
})
