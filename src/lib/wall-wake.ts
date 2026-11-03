/**
 * "Someone walked up" — a tiny signal from WallPresence to the screens that
 * hide the wall (quiet hours, the photo slideshow) so they step aside.
 */

const listeners = new Set<() => void>()

export function onWallWake(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function wakeWall() {
  for (const l of listeners) l()
}
