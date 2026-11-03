/**
 * central-socket-client.ts — connects the hub server to lumora_central_socket_io.
 *
 * The hub authenticates as kind="hub" and joins hub:{hub_id} room.
 * After each local DB broadcast the hub emits hub:relay so all connected
 * kiosks and mobile apps receive the table:action event via the central relay.
 */

import { io, type Socket } from "socket.io-client"
import { getDb } from "../db"
import { getCentralKioskCredentials } from "./central-registry"
import { registerRemoteRpc } from "../services/remote-rpc"
import { registerInviteRpc } from "../services/invite-relay"
import {
  onSupportRequest, recordSoloraAction, setSupportHubJwt, syncSoloraActions,
  type HouseholdGrant, type SoloraAction,
} from "../services/solora-support"

const CENTRAL_SOCKET_URL = process.env.CENTRAL_SOCKET_URL ?? "http://localhost:5001"
const CENTRAL_API_URL    = process.env.CENTRAL_API_URL    ?? "http://localhost:4000"

let _socket:    Socket | null = null
let _hubJwt:    string | null = null
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null

function sendRestHeartbeat(hubJwt: string): void {
  const db = getDb()
  const kiosks = db.prepare(
    "SELECT id, is_online, wifi_signal FROM kiosk_devices WHERE household_id IS NOT NULL"
  ).all() as Array<{ id: string; is_online: number; wifi_signal: number | null }>

  const devices = kiosks.flatMap(k => {
    const creds = getCentralKioskCredentials(k.id)
    if (!creds) return []   // not yet registered with central — skip
    return [{ id: creds.central_device_id, is_online: k.is_online === 1, wifi_signal: k.wifi_signal ?? null }]
  })

  fetch(`${CENTRAL_API_URL}/devices/heartbeat`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${hubJwt}` },
    body:    JSON.stringify({ devices }),
    signal:  AbortSignal.timeout(5000),
  }).catch((e) => console.warn("[central] heartbeat failed:", (e as Error).message))
}

/** Connect to the central socket server using the hub's JWT. */
export function connectHubToCentral(hubJwt: string): void {
  if (_socket?.connected && _hubJwt === hubJwt) return

  if (_socket) {
    _socket.disconnect()
    _socket = null
  }
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer)
    _heartbeatTimer = null
  }

  _hubJwt = hubJwt
  setSupportHubJwt(hubJwt)

  _socket = io(CENTRAL_SOCKET_URL, {
    auth:        { token: hubJwt },
    transports:  ["websocket"],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 30_000,
  })

  _socket.on("connect", () => {
    console.log("[central-socket] Hub connected to central socket  url=" + CENTRAL_SOCKET_URL)
    registerRemoteRpc(_socket!)
    registerInviteRpc(_socket!)
    _socket?.emit("hub:heartbeat", { kiosk_count: 0, online_count: 0 })
    // Send REST heartbeat immediately so portal shows hub as online
    sendRestHeartbeat(hubJwt)
    // Then every 60 seconds
    _heartbeatTimer = setInterval(() => sendRestHeartbeat(hubJwt), 60_000)
    // Anything Solora did while this hub was offline.
    syncSoloraActions().catch((e) => console.warn("[central] Solora activity sync failed:", (e as Error).message))
  })

  // What Solora does to this hub, live, so the family sees it in Privacy & support.
  _socket.on("manufacturer:action", (a: SoloraAction) => recordSoloraAction(a))
  _socket.on("support:request", (grant: HouseholdGrant) => onSupportRequest(grant))

  _socket.on("disconnect", (reason: string) => {
    console.log("[central-socket] Hub disconnected from central socket:", reason)
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null }
  })

  _socket.on("connect_error", (err: Error) => {
    console.warn("[central-socket] connect_error:", err.message)
  })
}

/**
 * Relay a local table:action event to all clients in the hub's room via
 * the central socket server. Called by broadcaster.ts after every DB write.
 *
 * The central socket server handles the "hub:relay" event by re-emitting
 * the payload to the hub:{hub_id} room — reaching all kiosks and mobile apps.
 */
export function relayEvent(event: string, payload: unknown): void {
  if (!_socket?.connected) return
  _socket.emit("hub:relay", { event, payload })
}

export function isCentralConnected(): boolean {
  return _socket?.connected ?? false
}
