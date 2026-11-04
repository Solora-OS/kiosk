/**
 * hub-transfer.ts — moving a household from one hub to another (an upgrade or
 * a replacement), so the new hub doesn't start empty.
 *
 *   Old hub: an admin starts a move and gets a one-time transfer code (30 min).
 *   New hub: its own screen, before setup, sends the code to POST /transfer/pull.
 *            The new hub finds the old one on the LAN (or uses the address
 *            given), downloads the household and its photos, and links its
 *            own display to it.
 *
 * Everything that crosses the network (rows, calendar tokens, photos) is
 * AES-256-GCM encrypted under a key derived from the code with scrypt, so the
 * plaintext LAN never carries a family's data or Google tokens in the clear.
 * Calendar tokens are decrypted with the old hub's secret and re-encrypted
 * with the new one's.
 *
 * Contract source: kiosk/src/app/kiosk/activate-screen.tsx (pull) and
 * mobile/src/app/settings/move-hub-sheet.tsx (start).
 */

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { Bonjour } from "bonjour-service"
import { getDb, PHOTOS_DIR } from "../db"
import { getOrCreateHubIdentity } from "../lib/hub-identity"
import { decryptToken, encryptToken } from "../lib/token-crypto"

const TRANSFER_TTL_MS = 30 * 60 * 1000
const MAX_FAILED_TRIES = 10

/** Household tables in the order rows can be inserted (parents before children). */
const TABLES = [
  "households", "users", "members", "calendars", "events", "chores", "lists", "list_items",
  "meals", "notifications", "notification_states", "photos", "calendar_providers",
  "calendar_provider_mappings", "calendar_excluded_events", "activity_logs",
  "chore_completions", "rewards", "redemptions",
] as const

type Row = Record<string, unknown>
export type HouseholdArchive = {
  format: 1
  householdId: string
  tables: Record<string, Row[]>
  photos: string[]
}

// ----- Codes and encryption ------------------------------------------------------

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

/** "ab3d efgh" or "AB3D-EFGH" → "AB3D-EFGH". */
export function normalizeTransferCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "")
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

function newCode(): string {
  const bytes = crypto.randomBytes(8)
  const raw = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("")
  return `${raw.slice(0, 4)}-${raw.slice(4)}`
}

const keyCache = new Map<string, Buffer>()

/** scrypt makes guessing the code from captured traffic slow, not just impossible to read. */
function keyFor(code: string): Buffer {
  let key = keyCache.get(code)
  if (!key) {
    key = crypto.scryptSync(code, "solora-hub-transfer", 32)
    keyCache.set(code, key)
  }
  return key
}

/** iv (12) ‖ ciphertext ‖ tag (16) */
export function seal(code: string, plain: Buffer): Buffer {
  const iv = crypto.randomBytes(12)
  const enc = crypto.createCipheriv("aes-256-gcm", keyFor(code), iv)
  return Buffer.concat([iv, enc.update(plain), enc.final(), enc.getAuthTag()])
}

export function open(code: string, sealed: Buffer): Buffer {
  const dec = crypto.createDecipheriv("aes-256-gcm", keyFor(code), sealed.subarray(0, 12))
  dec.setAuthTag(sealed.subarray(-16))
  return Buffer.concat([dec.update(sealed.subarray(12, -16)), dec.final()])
}

// ----- Old hub: offering a household ---------------------------------------------

type Pending = { code: string; householdId: string; expiresAt: number; failedTries: number }
let pending: Pending | null = null

/** Starts (or restarts) a move for this household. Only one move can be open at a time. */
export function startTransfer(householdId: string): { code: string; expiresAt: string } {
  const code = newCode()
  const expiresAt = Date.now() + TRANSFER_TTL_MS
  pending = { code, householdId, expiresAt, failedTries: 0 }
  return { code, expiresAt: new Date(expiresAt).toISOString() }
}

/** The household an open move is for, if `input` is its code. Too many wrong codes cancel the move. */
export function householdForCode(input: string | undefined): string | null {
  if (!pending || Date.now() > pending.expiresAt) { pending = null; return null }
  const given = Buffer.from(normalizeTransferCode(input ?? ""))
  const expected = Buffer.from(pending.code)
  if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return pending.householdId
  if (++pending.failedTries >= MAX_FAILED_TRIES) pending = null
  return null
}

export function finishTransfer(): void {
  pending = null
}

/** Every row that belongs to the household, plus the photo files to fetch. */
export function exportHousehold(householdId: string): HouseholdArchive {
  const db = getDb()
  const tables: Record<string, Row[]> = {}
  for (const table of TABLES) {
    const sql =
      table === "households" ? "SELECT * FROM households WHERE id = ?"
      : table === "list_items" ? "SELECT * FROM list_items WHERE list_id IN (SELECT id FROM lists WHERE household_id = ?)"
      : table === "notification_states"
        ? "SELECT * FROM notification_states WHERE notification_id IN (SELECT id FROM notifications WHERE household_id = ?)"
      : `SELECT * FROM ${table} WHERE household_id = ?`
    try {
      tables[table] = db.prepare(sql).all(householdId) as Row[]
    } catch {
      tables[table] = [] // table not in this hub's schema version
    }
  }
  // Calendar tokens are encrypted with this hub's secret; send them readable
  // (inside the sealed archive) so the new hub can encrypt them with its own.
  tables.calendar_providers = tables.calendar_providers.map((r) => ({
    ...r,
    access_token: decryptToken(String(r.access_token)),
    refresh_token: r.refresh_token ? decryptToken(String(r.refresh_token)) : null,
  }))
  const photos = tables.photos.map((p) => String(p.filename))
  return { format: 1, householdId, tables, photos }
}

/** A photo file of the household being moved, or null if it isn't one of theirs. */
export function readHouseholdPhoto(householdId: string, filename: string): Buffer | null {
  const owned = getDb()
    .prepare("SELECT 1 FROM photos WHERE household_id = ? AND filename = ?")
    .get(householdId, filename)
  if (!owned) return null
  const file = path.join(PHOTOS_DIR, path.basename(filename))
  return fs.existsSync(file) ? fs.readFileSync(file) : null
}

// ----- New hub: taking a household over -------------------------------------------

/** Claimed hubs on this network other than this one, as API base URLs. */
async function findOtherHubs(timeoutMs = 4000): Promise<string[]> {
  const self = getOrCreateHubIdentity().id
  const bonjour = new Bonjour()
  const found = new Set<string>()
  const browser = bonjour.find({ type: "solora" }, (service) => {
    const txt = (service.txt ?? {}) as Record<string, string>
    if (txt.hub_id === self || txt.claimed !== "1") return
    const ipv4 = (service.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
    if (ipv4) found.add(`http://${ipv4}:${service.port}/api/v1`)
  })
  await new Promise((r) => setTimeout(r, timeoutMs))
  browser.stop()
  bonjour.destroy()
  return [...found]
}

async function fetchSealed(baseUrl: string, urlPath: string, code: string): Promise<Buffer | null> {
  try {
    const res = await fetch(`${baseUrl}${urlPath}`, {
      headers: { "X-Transfer-Code": code },
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return null
    return open(code, Buffer.from(await res.arrayBuffer()))
  } catch {
    return null
  }
}

/** Inserts rows using only the columns this hub's schema has (the old hub may be an older version). */
function insertRows(table: string, rows: Row[]): void {
  if (rows.length === 0) return
  const db = getDb()
  const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
  if (columns.size === 0) return
  for (const row of rows) {
    const keys = Object.keys(row).filter((k) => columns.has(k))
    db.prepare(`INSERT OR REPLACE INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`)
      .run(...keys.map((k) => row[k] as never))
  }
}

export type PullResult = {
  householdName: string
  members: number
  events: number
  chores: number
  lists: number
  meals: number
  photos: number
  calendarsLinked: number
}

export class TransferError extends Error {}

/**
 * Pulls a household into this (unclaimed) hub from the hub holding `code`:
 * `from` if given, otherwise any claimed hub on this network.
 */
export async function pullHousehold(code: string, from?: string): Promise<PullResult> {
  const db = getDb()
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM households").get() as { n: number }
  if (n > 0) throw new TransferError("This hub is already set up, so it can't take over another household.")

  const normalized = normalizeTransferCode(code)
  const candidates = from ? [from] : await findOtherHubs()
  if (candidates.length === 0) {
    throw new TransferError("Couldn't find your old hub. Make sure it's plugged in and on the same Wi-Fi, or enter its address.")
  }

  let source: string | null = null
  let archive: HouseholdArchive | null = null
  for (const baseUrl of candidates) {
    const plain = await fetchSealed(baseUrl, "/transfer/export", normalized)
    if (plain) { source = baseUrl; archive = JSON.parse(plain.toString("utf8")) as HouseholdArchive; break }
  }
  if (!source || !archive) {
    throw new TransferError("Your old hub didn't accept that code. Check it, or start the move again on your phone.")
  }

  // Photos first, so a failed download leaves nothing half-imported.
  fs.mkdirSync(PHOTOS_DIR, { recursive: true })
  const photoFiles: [string, Buffer][] = []
  for (const filename of archive.photos) {
    const data = await fetchSealed(source, `/transfer/photo/${encodeURIComponent(filename)}`, normalized)
    if (!data) throw new TransferError("A photo didn't come across. Nothing was changed; try again.")
    photoFiles.push([path.basename(filename), data])
  }

  const tables = { ...archive.tables }
  tables.calendar_providers = (tables.calendar_providers ?? []).map((r) => ({
    ...r,
    access_token: encryptToken(String(r.access_token)),
    refresh_token: r.refresh_token ? encryptToken(String(r.refresh_token)) : null,
  }))

  db.transaction(() => {
    for (const table of TABLES) insertRows(table, tables[table] ?? [])
    // This hub's own screen (and any display waiting to pair) joins the household.
    db.prepare("UPDATE kiosk_devices SET household_id = ?, pairing_code = NULL WHERE household_id IS NULL")
      .run(archive!.householdId)
  })()
  for (const [name, data] of photoFiles) fs.writeFileSync(path.join(PHOTOS_DIR, name), data)

  // Tell the old hub the move is done so its code stops working.
  await fetch(`${source}/transfer/finish`, {
    method: "POST",
    headers: { "X-Transfer-Code": normalized },
    signal: AbortSignal.timeout(8000),
  }).catch(() => {})

  const count = (t: string) => (tables[t] ?? []).length
  return {
    householdName: String(tables.households?.[0]?.name ?? "Your family"),
    members: count("members"),
    events: count("events"),
    chores: count("chores"),
    lists: count("lists"),
    meals: count("meals"),
    photos: photoFiles.length,
    calendarsLinked: count("calendar_providers"),
  }
}
