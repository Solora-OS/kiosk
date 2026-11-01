/**
 * hub-identity.ts — a local, central-independent identity for this hub.
 *
 * Deliberately separate from central-registry.ts's `hub_id`: that id isn't
 * available until the async central registration succeeds (and central may
 * be unreachable), while mDNS advertisement and GET /hub/info must work
 * immediately at boot regardless of central connectivity.
 */

import fs from "fs"
import path from "path"
import crypto from "crypto"

const LUMORA_DIR    = path.join(process.env.HOME ?? ".", ".lumora")
const IDENTITY_PATH = path.join(LUMORA_DIR, "hub-identity.json")

export interface HubIdentity {
  id: string // stable local UUID, generated once, never changes
  name: string
  created_at: string
}

let _identity: HubIdentity | null = null

/** Loads (or creates on first boot) the hub's local mDNS identity. Synchronous — safe to call before central registration completes. */
export function getOrCreateHubIdentity(): HubIdentity {
  if (_identity) return _identity

  try {
    _identity = JSON.parse(fs.readFileSync(IDENTITY_PATH, "utf-8")) as HubIdentity
    return _identity
  } catch {
    // fall through to create
  }

  fs.mkdirSync(LUMORA_DIR, { recursive: true })
  const identity: HubIdentity = {
    id: crypto.randomUUID(),
    name: process.env.HUB_NAME ?? "Solora Hub",
    created_at: new Date().toISOString(),
  }
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2), "utf-8")
  _identity = identity
  return identity
}
