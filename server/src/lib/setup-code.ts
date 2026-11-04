/**
 * setup-code.ts — the one-time code that proves you're the person setting up
 * this hub.
 *
 * The first account to sign in must present it (POST /auth/session), so
 * nobody else on the network can claim the hub before its owner. It's made on
 * first boot and shown on the hub's own screen, along with a QR code a phone
 * can scan, until the hub has a household (GET /hub/setup).
 */

import crypto from "crypto"
import fs from "fs"
import path from "path"
import { DATA_DIR } from "../db"

const SETUP_CODE_PATH = path.join(DATA_DIR, "setup_code")

/** This hub's setup code, created and saved the first time it's asked for. */
export function getOrCreateSetupCode(): string {
  try {
    const existing = fs.readFileSync(SETUP_CODE_PATH, "utf8").trim()
    if (existing) return existing
  } catch {
    // Not made yet.
  }
  const code = crypto.randomBytes(4).toString("hex").toUpperCase()
  fs.mkdirSync(path.dirname(SETUP_CODE_PATH), { recursive: true })
  fs.writeFileSync(SETUP_CODE_PATH, code, { mode: 0o600 })
  console.log(`[setup] Hub setup code: ${code}  (shown on the hub's screen until it's set up)`)
  return code
}

/** Whether a setup code a person typed matches, ignoring case, spaces and dashes. */
export function setupCodeMatches(input: string | undefined): boolean {
  if (!input) return false
  return input.toUpperCase().replace(/[^0-9A-F]/g, "") === getOrCreateSetupCode()
}
