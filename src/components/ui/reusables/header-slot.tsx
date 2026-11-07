"use client"

import { useSyncExternalStore, type ReactNode } from "react"
import { createPortal } from "react-dom"

type Slot = "title" | "extras"

const slots: Record<Slot, HTMLElement | null> = { title: null, extras: null }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** The header calls this with its slot elements as they mount and unmount. */
export function setHeaderSlot(name: Slot, el: HTMLElement | null) {
  if (slots[name] === el) return
  slots[name] = el
  emit()
}

function useSlot(name: Slot) {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => slots[name],
  )
}

/**
 * Puts a page's own piece into the shared header: a title that isn't plain text
 * (Home's clock, the calendar's month and arrows) or controls that sit left of
 * the action pill (a Day/Week/Month toggle). Renders nothing in the page itself.
 */
export function HeaderSlot({ name, children }: { name: Slot; children: ReactNode }) {
  const el = useSlot(name)
  return el ? createPortal(children, el) : null
}
