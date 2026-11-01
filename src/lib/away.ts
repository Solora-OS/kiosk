/**
 * away.ts — the household's away time, shared by every screen that shows it.
 * Kept identical in mobile/ and kiosk/.
 */

import { useEffect, useState } from "react"
import { api } from "./api"
import type { Away } from "./data"

let current: Away | null = null
const listeners = new Set<(a: Away | null) => void>()

function publish(a: Away | null) {
  current = a
  for (const fn of listeners) fn(a)
}

export async function refreshAway(): Promise<void> {
  try { publish(await api.getAway()) } catch { /* keep the last known value while the hub is away */ }
}

export async function setAway(input: Away): Promise<void> {
  publish(await api.setAway(input))
}

export async function endAway(): Promise<void> {
  await api.endAway()
  publish(null)
}

/** Whether `iso` falls inside the away time. */
export function isAwayOn(away: Away | null, iso: string): boolean {
  return !!away && iso >= away.from && iso <= away.until
}

/** The current away time; refreshed on mount, on focus and every minute. */
export function useAway(): Away | null {
  const [away, setLocal] = useState(current)
  useEffect(() => {
    listeners.add(setLocal)
    void refreshAway()
    const id = setInterval(() => void refreshAway(), 60_000)
    const onFocus = () => void refreshAway()
    window.addEventListener("focus", onFocus)
    return () => { listeners.delete(setLocal); clearInterval(id); window.removeEventListener("focus", onFocus) }
  }, [])
  return away
}
