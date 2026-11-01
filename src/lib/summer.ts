// ---------------------------------------------------------------------------
// summer.ts
//
// The house's summer break, from the hub. While it lasts, chores follow their
// summer rule (different days, off, or summer-only), so a family sets two
// dates once a year instead of editing every chore twice.
//
// Kept identical in mobile/ and kiosk/. Each app's API module registers how
// to save to its hub; its store hands over what the hub sent.
// ---------------------------------------------------------------------------

import { useSyncExternalStore } from "react"
import type { Summer } from "./data"

const KEY = "solora.summer"

function load(): Summer | null {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? (JSON.parse(raw) as Summer) : null
  } catch {
    return null
  }
}

let current = load()
const listeners = new Set<() => void>()
let saver: ((range: Summer | null) => Promise<Summer | null>) | null = null

/** What the hub sent: the summer break, or null for none. Undefined (an older hub) changes nothing. */
export function setSummer(range: Summer | null | undefined): void {
  if (range === undefined) return
  current = range
  try { localStorage.setItem(KEY, JSON.stringify(range)) } catch { /* kept for this visit */ }
  for (const fn of listeners) fn()
}

export function getSummer(): Summer | null {
  return current
}

export function useSummer(): Summer | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
}

/** Each app's API module says how to save to its hub. */
export function registerSummerSaver(fn: (range: Summer | null) => Promise<Summer | null>): void {
  saver = fn
}

/** Set (or clear, with null) the summer break for the whole house. */
export async function saveSummer(range: Summer | null): Promise<void> {
  if (!saver) throw new Error("Not connected to a hub.")
  setSummer(await saver(range))
}
