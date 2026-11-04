/**
 * invite-relay.ts — joining this household from outside its Wi-Fi.
 *
 * When an invite is created the hub registers SHA-256(INVITE_LABEL + ":" + code)
 * (and the same for the invite's QR token) with central, along with this hub's
 * P-256 public key. An invitee who can't reach the hub on the LAN looks the
 * invite up at central, derives a shared AES key by ECDH with that public key,
 * and sends `hub:invite-rpc` calls through central: look the invite up, then
 * claim it. Central routes bytes it can't read.
 *
 * Contract source: central/src/routes/invites.ts and mobile/src/lib/invite-remote.ts.
 */

import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { DATA_DIR } from "../db"
import { getHubJwt } from "../lib/central-registry"

const CENTRAL_API_URL = (process.env.CENTRAL_API_URL ?? "http://localhost:4000").replace(/\/$/, "")
const HUB_PORT = process.env.SOLORA_PORT ?? process.env.PORT ?? "4000"
const LOCAL_URL = `http://127.0.0.1:${HUB_PORT}/api/v1`
const KEY_FILE = path.join(DATA_DIR, "invite-ecdh.key")
// Wire constant shared with every phone (mobile/src/lib/invite-remote.ts) and the
// Rust hub. It predates the Solora name; changing it breaks invites between versions.
const INVITE_LABEL = "lumora-invite"

// ----- Keys ------------------------------------------------------------------

let _ecdh: crypto.ECDH | null = null

/** This hub's long-lived P-256 key pair for invite claims, created on first use. */
function ecdh(): crypto.ECDH {
  if (_ecdh) return _ecdh
  const key = crypto.createECDH("prime256v1")
  if (fs.existsSync(KEY_FILE)) {
    key.setPrivateKey(Buffer.from(fs.readFileSync(KEY_FILE, "utf8").trim(), "hex"))
  } else {
    key.generateKeys()
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
    fs.writeFileSync(KEY_FILE, key.getPrivateKey("hex"), { mode: 0o600 })
  }
  _ecdh = key
  return key
}

export function hubInvitePublicKey(): string {
  return ecdh().getPublicKey("base64", "uncompressed")
}

/** The routing key central knows an invite by: never the code itself. */
export function inviteLookup(tokenOrCode: string): string {
  return crypto.createHash("sha256").update(`${INVITE_LABEL}:${tokenOrCode.trim().toUpperCase()}`).digest("hex")
}

/** AES-256-GCM key shared with the app that sent `clientPub`, bound to the invite it asked about. */
function sharedKey(clientPub: string, lookup: string): Buffer {
  const secret = ecdh().computeSecret(Buffer.from(clientPub, "base64"))
  return Buffer.from(crypto.hkdfSync("sha256", secret, Buffer.from(INVITE_LABEL), Buffer.from(lookup), 32))
}

function decrypt(key: Buffer, iv: string, ciphertext: string): unknown {
  const ct = Buffer.from(ciphertext, "base64")
  const dec = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"))
  dec.setAuthTag(ct.subarray(-16))
  return JSON.parse(Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]).toString("utf8"))
}

function encrypt(key: Buffer, data: unknown): { iv: string; ciphertext: string } {
  const iv = crypto.randomBytes(12)
  const enc = crypto.createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([enc.update(JSON.stringify(data), "utf8"), enc.final(), enc.getAuthTag()])
  return { iv: iv.toString("base64"), ciphertext: ct.toString("base64") }
}

// ----- Registration with central ---------------------------------------------

async function centralCall(method: "PUT" | "DELETE", lookup: string, body?: unknown): Promise<void> {
  const jwt = getHubJwt()
  if (!jwt) return // Not registered with central (offline install): LAN joins still work.
  try {
    const res = await fetch(`${CENTRAL_API_URL}/invites/${lookup}`, {
      method,
      headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) console.warn(`[invite-relay] ${method} invite at central failed: ${res.status}`)
  } catch (e) {
    console.warn(`[invite-relay] ${method} invite at central failed:`, (e as Error).message)
  }
}

/** Lets this invite be found and claimed through central. Fire and forget. */
export function registerRemoteInvite(invite: { code: string; token: string; expiresAt: string }): void {
  const body = { hub_pub: hubInvitePublicKey(), expires_at: invite.expiresAt }
  void centralCall("PUT", inviteLookup(invite.code), body)
  void centralCall("PUT", inviteLookup(invite.token), body)
}

/** Stops routing a claimed or revoked invite. Fire and forget. */
export function unregisterRemoteInvite(invite: { code: string; token: string }): void {
  void centralCall("DELETE", inviteLookup(invite.code))
  void centralCall("DELETE", inviteLookup(invite.token))
}

// ----- Answering remote calls --------------------------------------------------

type InviteRpcEnvelope = {
  correlation_id:    string
  lookup:            string
  client_pub:        string
  encrypted_payload: string
  iv:                string
}

type InviteRpcPayload =
  | { op: "lookup"; key: string }
  | { op: "claim" | "claim-device"; key: string; body: Record<string, unknown> }

async function local(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${LOCAL_URL}${urlPath}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/**
 * Runs one remote invite call against this hub's own (unauthenticated) invite
 * routes. A call may only touch the invite central routed it by: the key must
 * hash to the envelope's lookup, and a claim must carry that invite's token.
 */
async function handle(payload: InviteRpcPayload, lookup: string): Promise<{ status: number; body: unknown }> {
  // A tap ticket is routed by the ticket alone; its ".1234" check rides along.
  if (inviteLookup(payload.key.split(".")[0]) !== lookup) return { status: 403, body: { error: "Invite mismatch." } }
  const found = await local("GET", `/invites/${encodeURIComponent(payload.key)}`)
  if (payload.op === "lookup" || found.status !== 200) return found
  const token = (found.body as { token?: string }).token
  if (payload.body.token !== token) return { status: 403, body: { error: "Invite mismatch." } }
  return local("POST", payload.op === "claim" ? "/invites/claim" : "/invites/claim-device", payload.body)
}

let _registeredOn: unknown = null

export function registerInviteRpc(socket: import("socket.io-client").Socket): void {
  // The socket object survives reconnects; attach the handler once.
  if (_registeredOn === socket) return
  _registeredOn = socket

  socket.on("hub:invite-rpc", async (envelope: InviteRpcEnvelope) => {
    const { correlation_id, lookup, client_pub } = envelope
    let key: Buffer
    let payload: InviteRpcPayload
    try {
      key = sharedKey(client_pub, lookup)
      payload = decrypt(key, envelope.iv, envelope.encrypted_payload) as InviteRpcPayload
    } catch (e) {
      console.warn("[invite-relay] decrypt failed:", (e as Error).message)
      socket.emit("hub:rpc:response", { correlation_id, ok: false, error: "Decryption failed" })
      return
    }
    try {
      const result = await handle(payload, lookup)
      socket.emit("hub:rpc:response", { correlation_id, ok: true, ...encrypt(key, result) })
      console.log(`[invite-relay] ${payload.op} → ${result.status}`)
    } catch (e) {
      console.warn("[invite-relay] internal call failed:", (e as Error).message)
      socket.emit("hub:rpc:response", { correlation_id, ok: false, error: "Hub internal error" })
    }
  })
}

// ----- LAN address -------------------------------------------------------------

/**
 * This hub's API base URL on the home network, for a phone that joined
 * remotely: it talks to the hub directly once home, and through the relay
 * until then.
 */
export function lanBaseUrl(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) return `http://${a.address}:${HUB_PORT}/api/v1`
    }
  }
  return null
}
