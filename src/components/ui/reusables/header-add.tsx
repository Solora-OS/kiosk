"use client"

import { useEffect, useRef, useSyncExternalStore } from "react"

type Add = { label: string; onClick: () => void }

let current: Add | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

// Quick add switches tab and asks for that page's add; it fires when the page offers one.
let pending: ReturnType<typeof setTimeout> | null = null

/** The add action the page on screen has offered, if any; the header shows it first in its cluster. */
export function useHeaderAdd(): Add | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current,
  )
}

/**
 * Run the add of the page about to open. If that page never offers one
 * (you can't add there), the request lapses instead of firing later.
 */
export function requestAdd() {
  if (pending) clearTimeout(pending)
  pending = setTimeout(() => (pending = null), 1500)
}

/**
 * Offers this page's add action to the header. Renders nothing; the action
 * goes away when the page unmounts.
 */
export function HeaderAdd({ label, onClick }: Add) {
  // The latest handler, so pages can pass inline functions without re-registering every render.
  const click = useRef(onClick)
  click.current = onClick

  useEffect(() => {
    const add: Add = { label, onClick: () => click.current() }
    current = add
    emit()
    if (pending) {
      clearTimeout(pending)
      pending = null
      add.onClick()
    }
    return () => {
      if (current === add) {
        current = null
        emit()
      }
    }
  }, [label])

  return null
}
