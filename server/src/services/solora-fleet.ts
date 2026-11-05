/**
 * solora-fleet.ts — what this hub does for the Solora console
 * (central/src/routes/fleet.ts and releases.ts), over the central socket:
 *
 *   hub:control { type: "diagnostics" }     → hub:diagnostics { report }: version, uptime,
 *                                              memory, storage, kiosk counts. Never household rows.
 *   hub:control { type: "restart" }         → exits so systemd restarts it (only under systemd)
 *   hub:control { type: "forget_device" }   → drops that kiosk's central login
 *   provision:update                        → the profile is for the displays; the hub notes it
 *   flags:update                            → kept for isFeatureOn()
 *   hub:update                              → logged and noted; installing a hub build is a
 *                                              deploy step (kiosk/server has no self-updater yet)
 *
 * Every one of these also reaches the family's activity feed through
 * manufacturer:action (services/solora-support.ts), which central sends itself.
 */

import fs from "fs"
import os from "os"
import type { Socket } from "socket.io-client"
import { DB_PATH, getDb } from "../db"
import { forgetCentralDevice } from "../lib/central-registry"

// eslint-disable-next-line @typescript-eslint/no-require-imports
const HUB_VERSION: string = (() => { try { return require("../../package.json").version as string } catch { return "0.0.0" } })()
export const HUB_PLATFORM = `${process.platform}-${process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch}`

let flags: Record<string, boolean> = {}

export function isFeatureOn(key: string, fallback = false): boolean {
  return key in flags ? flags[key] : fallback
}

/** What hub:heartbeat carries besides counts, so the console can tell hubs apart. */
export function heartbeatIdentity() {
  return { version: HUB_VERSION, platform: HUB_PLATFORM }
}

function diagnostics(): Record<string, string | number | boolean | null> {
  const db = getDb()
  const count = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n } catch { return null } }
  let dbSize: number | null = null
  try { dbSize = Math.round(fs.statSync(DB_PATH).size / 1024 / 1024 * 10) / 10 } catch { /* none yet */ }
  return {
    version:       HUB_VERSION,
    platform:      HUB_PLATFORM,
    node:          process.version,
    uptime_s:      Math.round(process.uptime()),
    host_uptime_s: Math.round(os.uptime()),
    memory_mb:     Math.round(process.memoryUsage().rss / 1024 / 1024),
    host_free_mb:  Math.round(os.freemem() / 1024 / 1024),
    load_1m:       Math.round(os.loadavg()[0] * 100) / 100,
    db_size_mb:    dbSize,
    kiosks:        count("SELECT count(*) AS n FROM kiosk_devices"),
    kiosks_online: count("SELECT count(*) AS n FROM kiosk_devices WHERE is_online = 1"),
    under_systemd: !!process.env.INVOCATION_ID,
  }
}

type HubControl =
  | { type: "restart" }
  | { type: "diagnostics"; request_id: string }
  | { type: "forget_device"; device_id: string }

export function registerSoloraFleet(socket: Socket): void {
  socket.off("hub:control")
  socket.off("provision:update")
  socket.off("flags:update")
  socket.off("hub:update")

  socket.on("hub:control", (c: HubControl) => {
    switch (c?.type) {
      case "diagnostics":
        socket.emit("hub:diagnostics", { request_id: c.request_id, report: diagnostics() })
        break
      case "restart":
        // systemd (solora-server.service, Restart=on-failure) brings us back.
        // Outside systemd nothing would, so don't exit.
        if (!process.env.INVOCATION_ID) {
          console.warn("[solora-fleet] restart requested, but not running under systemd — ignoring")
          break
        }
        console.log("[solora-fleet] restart requested by Solora — exiting for systemd to restart")
        setTimeout(() => process.exit(75), 500)
        break
      case "forget_device": {
        const local = forgetCentralDevice(c.device_id)
        console.log(`[solora-fleet] Solora unpaired central device ${c.device_id}${local ? ` (local kiosk ${local})` : " (not ours)"}`)
        break
      }
    }
  })

  socket.on("provision:update", (p: { profile_id: string; name: string; revision: number; mode: string }) => {
    // Displays apply it and report for themselves; the hub has nothing of its own to set yet.
    console.log(`[solora-fleet] provisioning profile “${p.name}” r${p.revision} (${p.mode}) sent to this hub's displays`)
  })

  socket.on("flags:update", (p: { flags?: Record<string, boolean> }) => {
    flags = p?.flags ?? {}
  })

  socket.on("hub:update", (u: { version: string; force?: boolean }) => {
    console.log(`[solora-fleet] hub update v${u.version} available${u.force ? " (install now requested)" : ""} — install it with the deploy script`)
  })
}
