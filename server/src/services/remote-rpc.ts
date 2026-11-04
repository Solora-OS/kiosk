/**
 * remote-rpc.ts — handles hub:rpc events from the central socket server.
 *
 * When the iOS app is off the home network it sends encrypted API calls
 * through the central relay. This service:
 *   1. Decrypts the payload with the hub's remoteKey (AES-256-GCM)
 *   2. Validates the path against an allowlist
 *   3. Forwards it to the local Express server as an authenticated request
 *   4. Encrypts the response and emits hub:rpc:response back
 */

import crypto from "crypto"
import { getRemoteKey } from "../routes/auth"
import { signToken } from "../middleware/auth"

// Must match the port index.ts listens on (SOLORA_PORT); PORT kept as a fallback.
const HUB_PORT = process.env.SOLORA_PORT ?? process.env.PORT ?? "4000"
const LOCAL_URL = `http://127.0.0.1:${HUB_PORT}/api/v1`

const RELAY_ALLOWLIST = /^\/(?:snapshot|households|members|calendars|events|chores|lists|list_items|meals|notifications|photos|invites|auth\/me|kiosk-devices|rewards|away|home|calendar-links|ics-link|seasons|summer)(?:\/.*)?$/

type RpcPayload = {
  method:      string
  path:        string
  body?:       unknown
  userId:      string
  householdId: string
}

type RpcEnvelope = {
  correlation_id:    string
  encrypted_payload: string
  iv:                string
}

function decrypt(iv: string, ciphertext: string): RpcPayload {
  const key    = getRemoteKey()
  const ivBuf  = Buffer.from(iv, "base64")
  const ctFull = Buffer.from(ciphertext, "base64")
  // Web Crypto AES-GCM appends the 16-byte auth tag to the ciphertext
  const authTag = ctFull.slice(-16)
  const ctBuf   = ctFull.slice(0, -16)
  const dec     = crypto.createDecipheriv("aes-256-gcm", key, ivBuf)
  dec.setAuthTag(authTag)
  return JSON.parse(dec.update(ctBuf).toString("utf8") + dec.final("utf8")) as RpcPayload
}

function encrypt(data: unknown): { iv: string; ciphertext: string } {
  const key  = getRemoteKey()
  const iv   = crypto.randomBytes(12)
  const enc  = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ct   = Buffer.concat([enc.update(JSON.stringify(data), "utf8"), enc.final()])
  const tag  = enc.getAuthTag()
  return {
    iv:         iv.toString("base64"),
    ciphertext: Buffer.concat([ct, tag]).toString("base64"),
  }
}

let _registeredOn: unknown = null

export function registerRemoteRpc(socket: import("socket.io-client").Socket): void {
  // The socket object survives reconnects; attach the handler once, or every
  // relayed call would run once per reconnect since boot.
  if (_registeredOn === socket) return
  _registeredOn = socket
  socket.on("hub:rpc", async (envelope: RpcEnvelope) => {
    const { correlation_id, encrypted_payload, iv } = envelope

    let payload: RpcPayload
    try {
      payload = decrypt(iv, encrypted_payload)
    } catch (e) {
      console.warn("[remote-rpc] decrypt failed:", (e as Error).message)
      socket.emit("hub:rpc:response", { correlation_id, ok: false, error: "Decryption failed" })
      return
    }

    const { method, path, body, userId, householdId } = payload

    if (!RELAY_ALLOWLIST.test(path)) {
      console.warn("[remote-rpc] blocked path:", path)
      socket.emit("hub:rpc:response", { correlation_id, ok: false, error: "Path not allowed" })
      return
    }

    // Issue a short-lived relay token so all existing route middleware is reused
    const relayToken = signToken({ sub: userId, householdId, role: "member", email: "" }, "30s")

    let status: number
    let responseBody: unknown
    try {
      const res = await fetch(`${LOCAL_URL}${path}`, {
        method:  method.toUpperCase(),
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${relayToken}`,
        },
        body:   body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(12_000),
      })
      status      = res.status
      responseBody = await res.json().catch(() => null)
    } catch (e) {
      console.warn("[remote-rpc] internal fetch failed:", (e as Error).message)
      socket.emit("hub:rpc:response", { correlation_id, ok: false, error: "Hub internal error" })
      return
    }

    const encrypted = encrypt({ status, body: responseBody })
    socket.emit("hub:rpc:response", { correlation_id, ok: true, ...encrypted })
    console.log(`[remote-rpc] ${method} ${path} → ${status}`)
  })
}
