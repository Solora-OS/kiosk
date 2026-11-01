"use client"

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react"
import { createPortal } from "react-dom"
import { Pencil, Trash2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { hapticImpact, hapticSelection } from "@/lib/haptics"

const TILE_WIDTH = 68
const TILE_GAP = 6
const LEAD_GAP = 8 // space between the card and the first action tile
const INSET = 4 // action tiles sit inset from the row edges so nothing bleeds behind rounded corners
const LONG_PRESS_MS = 450
const SLOP = 8 // px of movement before we decide between swipe and scroll
const FULL_SWIPE_RATIO = 0.6
const FLICK_VELOCITY = 0.45 // px/ms
const MENU_MARGIN = 12

type Action = {
  key: string
  label: string
  icon: ComponentType<{ className?: string }>
  tone: string
  destructive?: boolean
  onSelect: () => void
}

const rubberBand = (distance: number) => Math.sqrt(distance) * 3

/**
 * A list row with edit/delete actions, following platform conventions:
 * - Long-press (touch) or right-click (mouse) opens a context menu with the row lifted above a dimmed backdrop.
 * - Swipe LEFT reveals inset action tiles; a full swipe deletes.
 * - Keyboard: Shift+F10 / ContextMenu key opens the menu, Delete triggers delete.
 */
export function ActionRow({
  children,
  onEdit,
  onDelete,
  editLabel = "Edit",
  editIcon = Pencil,
  deleteLabel = "Delete",
  className,
  rounded = "rounded-md",
}: {
  children: ReactNode
  onEdit?: () => void
  onDelete?: () => void
  editLabel?: string
  editIcon?: ComponentType<{ className?: string }>
  deleteLabel?: string
  className?: string
  rounded?: string
}) {
  const actions: Action[] = []
  if (onEdit) actions.push({ key: "edit", label: editLabel, icon: editIcon, tone: "bg-member-blue", onSelect: onEdit })
  if (onDelete)
    actions.push({ key: "delete", label: deleteLabel, icon: Trash2, tone: "bg-destructive", destructive: true, onSelect: onDelete })
  const hasActions = actions.length > 0
  const revealWidth = hasActions ? LEAD_GAP + actions.length * TILE_WIDTH + (actions.length - 1) * TILE_GAP + INSET : 0

  const rootRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const offsetRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const [armed, setArmed] = useState(false) // full swipe will delete on release
  const armedRef = useRef(false)
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null)
  const longPressTimer = useRef<number | undefined>(undefined)
  const suppressClick = useRef(false)
  const returnFocus = useRef<HTMLElement | null>(null)
  const gesture = useRef({ active: false, axis: null as "x" | "y" | null, x0: 0, y0: 0, offset0: 0, width: 0, lastX: 0, lastT: 0, velocity: 0 })

  const moveTo = (value: number) => {
    offsetRef.current = value
    setOffset(value)
  }
  const setArmedState = (value: boolean) => {
    armedRef.current = value
    setArmed(value)
  }
  const clearLongPress = () => window.clearTimeout(longPressTimer.current)

  const close = useCallback(() => {
    offsetRef.current = 0
    setOffset(0)
    armedRef.current = false
    setArmed(false)
  }, [])

  // While swiped open, any press outside the row closes it.
  const isOpen = offset !== 0 && !dragging
  useEffect(() => {
    if (!isOpen) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener("pointerdown", onDown, true)
    return () => document.removeEventListener("pointerdown", onDown, true)
  }, [isOpen, close])

  useEffect(() => clearLongPress, [])

  const openMenu = () => {
    clearLongPress()
    const el = rootRef.current
    if (!el || !hasActions) return
    gesture.current.active = false
    suppressClick.current = true
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    close()
    hapticImpact("medium")
    setMenuRect(el.getBoundingClientRect())
  }

  const closeMenu = () => {
    setMenuRect(null)
    returnFocus.current?.focus?.({ preventScroll: true })
  }

  const settle = (allowDelete: boolean) => {
    const g = gesture.current
    setDragging(false)
    if (armedRef.current && allowDelete && onDelete) {
      // Slide the card off, then hand off to the delete flow (which may confirm and bring it back).
      moveTo(-g.width)
      window.setTimeout(() => {
        onDelete()
        close()
      }, 180)
      return
    }
    setArmedState(false)
    const shouldOpen =
      g.velocity < -FLICK_VELOCITY ? true : g.velocity > FLICK_VELOCITY ? false : offsetRef.current < -revealWidth / 2
    moveTo(shouldOpen ? -revealWidth : 0)
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    suppressClick.current = false
    if (!hasActions || (e.pointerType === "mouse" && e.button !== 0)) return
    const g = gesture.current
    g.active = true
    g.axis = null
    g.x0 = g.lastX = e.clientX
    g.y0 = e.clientY
    g.lastT = e.timeStamp
    g.velocity = 0
    g.offset0 = offsetRef.current
    g.width = rootRef.current?.offsetWidth ?? 320
    if (offsetRef.current === 0) longPressTimer.current = window.setTimeout(openMenu, LONG_PRESS_MS)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current
    if (!g.active) return
    const dx = e.clientX - g.x0
    const dy = e.clientY - g.y0

    if (g.axis === null) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return
      clearLongPress()
      if (Math.abs(dx) <= Math.abs(dy)) {
        // Vertical intent: let the page scroll.
        g.axis = "y"
        g.active = false
        return
      }
      g.axis = "x"
      suppressClick.current = true
      setDragging(true)
      e.currentTarget.setPointerCapture?.(e.pointerId)
    }

    const dt = e.timeStamp - g.lastT
    if (dt > 0) g.velocity = (e.clientX - g.lastX) / dt
    g.lastX = e.clientX
    g.lastT = e.timeStamp

    let next = g.offset0 + dx
    if (next > 0) next = rubberBand(next)
    else if (!onDelete && next < -revealWidth) next = -revealWidth - rubberBand(-revealWidth - next)
    next = Math.max(next, -g.width)

    const shouldArm = !!onDelete && -next > g.width * FULL_SWIPE_RATIO
    if (shouldArm !== armedRef.current) {
      setArmedState(shouldArm)
      hapticSelection()
    }
    moveTo(next)
  }

  const onPointerUp = () => {
    clearLongPress()
    const g = gesture.current
    if (!g.active) return
    g.active = false
    if (g.axis === "x") settle(true)
    else if (g.axis === null && offsetRef.current !== 0) {
      // A tap on an open row closes it instead of activating its content.
      suppressClick.current = true
      close()
    }
  }

  const onPointerCancel = () => {
    clearLongPress()
    const g = gesture.current
    if (g.active && g.axis === "x") settle(false)
    g.active = false
  }

  const onClickCapture = (e: ReactMouseEvent) => {
    if (!suppressClick.current) return
    suppressClick.current = false
    e.preventDefault()
    e.stopPropagation()
  }

  const onContextMenu = (e: ReactMouseEvent) => {
    if (!hasActions) return
    e.preventDefault()
    if (!menuRect) openMenu()
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!hasActions || menuRect) return
    if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      e.preventDefault()
      openMenu()
    } else if ((e.key === "Delete" || e.key === "Backspace") && onDelete) {
      e.preventDefault()
      onDelete()
    }
  }

  const reveal = Math.max(0, -offset)
  const progress = revealWidth ? Math.min(1, reveal / revealWidth) : 0
  const easing = !dragging && "transition-all duration-300 ease-out-quart motion-reduce:transition-none"

  return (
    <div
      ref={rootRef}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      className={cn("relative select-none overflow-hidden", className)}
      style={{ WebkitTouchCallout: "none" }}
    >
      {hasActions ? (
        <div
          aria-hidden={offset === 0}
          className={cn("absolute inset-y-0 right-0 flex", easing)}
          style={{ width: reveal, padding: `${INSET}px ${INSET}px ${INSET}px ${LEAD_GAP}px`, opacity: Math.min(1, progress * 1.4) }}
        >
          {actions.map((action, i) => {
            const collapsed = armed && !action.destructive
            const Icon = action.icon
            return (
              <button
                key={action.key}
                type="button"
                tabIndex={offset === 0 ? -1 : 0}
                onClick={() => {
                  close()
                  action.onSelect()
                }}
                className={cn(
                  "flex min-w-0 basis-0 items-center overflow-hidden rounded-xl text-white active:brightness-90",
                  action.tone,
                  armed && action.destructive ? "justify-start pl-5" : "justify-center",
                  "transition-all duration-200 ease-out-quart motion-reduce:transition-none",
                )}
                style={{
                  flexGrow: collapsed ? 0 : 1,
                  opacity: collapsed ? 0 : 1,
                  marginRight: i < actions.length - 1 && !collapsed ? TILE_GAP : 0,
                }}
              >
                <span
                  className="flex flex-col items-center gap-1 text-[0.75rem] font-semibold"
                  style={{ transform: `scale(${0.6 + 0.4 * progress})` }}
                >
                  <Icon className="size-[18px]" />
                  {action.label}
                </span>
              </button>
            )
          })}
        </div>
      ) : null}

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onClickCapture={onClickCapture}
        className={cn(
          "relative touch-pan-y overflow-hidden",
          rounded,
          !dragging && "transition-transform duration-300 ease-out-quart motion-reduce:transition-none",
          menuRect && "opacity-0",
        )}
        style={{ transform: `translateX(${offset}px)` }}
      >
        {children}
      </div>

      {menuRect ? (
        <ActionMenu rect={menuRect} actions={actions} onClose={closeMenu}>
          {children}
        </ActionMenu>
      ) : null}
    </div>
  )
}

/** Context menu with a lifted preview of the row, iOS-style. */
function ActionMenu({
  rect,
  actions,
  children,
  onClose,
}: {
  rect: DOMRect
  actions: Action[]
  children: ReactNode
  onClose: () => void
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [shown, setShown] = useState(false)
  const [layout, setLayout] = useState<{ top: number; left: number; shift: number; above: boolean } | null>(null)
  const closing = useRef(false)

  const dismiss = useCallback(
    (after?: () => void) => {
      if (closing.current) return
      closing.current = true
      setShown(false)
      window.setTimeout(() => {
        onClose()
        after?.()
      }, 140)
    },
    [onClose],
  )

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (!menu) return
    const vw = window.innerWidth
    const vh = window.innerHeight
    const h = menu.offsetHeight
    const w = menu.offsetWidth
    const left = Math.min(Math.max(rect.left, MENU_MARGIN), vw - w - MENU_MARGIN)
    if (rect.bottom + 8 + h <= vh - MENU_MARGIN) {
      setLayout({ top: rect.bottom + 8, left, shift: 0, above: false })
    } else if (rect.top - 8 - h >= MENU_MARGIN) {
      setLayout({ top: rect.top - 8 - h, left, shift: 0, above: true })
    } else {
      // Not enough room either side: nudge the preview up so the menu fits below it.
      const overflow = rect.bottom + 8 + h - (vh - MENU_MARGIN)
      const shift = -Math.min(overflow, Math.max(0, rect.top - MENU_MARGIN))
      setLayout({ top: Math.min(rect.bottom + shift + 8, vh - MENU_MARGIN - h), left, shift, above: false })
    }
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [rect])

  // Focus the first item once positioned (hidden elements can't take focus).
  const positioned = layout !== null
  useEffect(() => {
    if (positioned) menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true })
  }, [positioned])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        dismiss()
        return
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Tab") return
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])
      if (!items.length) return
      e.preventDefault()
      const i = items.indexOf(document.activeElement as HTMLElement)
      const back = e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)
      items[(i + (back ? -1 : 1) + items.length) % items.length].focus()
    }
    const onViewportChange = () => dismiss()
    document.addEventListener("keydown", onKey)
    window.addEventListener("resize", onViewportChange)
    window.addEventListener("scroll", onViewportChange, true)
    return () => {
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("resize", onViewportChange)
      window.removeEventListener("scroll", onViewportChange, true)
    }
  }, [dismiss])

  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation()

  return createPortal(
    <div
      className="fixed inset-0 z-[60] select-none"
      style={{ WebkitTouchCallout: "none" }}
      onClick={stop}
      onPointerDown={stop}
      onKeyDown={stop}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/30 backdrop-blur-[3px] transition-opacity duration-200 motion-reduce:transition-none",
          shown ? "opacity-100" : "opacity-0",
        )}
        onPointerDown={() => dismiss()}
      />

      <div
        aria-hidden
        inert
        className="pointer-events-none absolute overflow-hidden rounded-xl transition-[transform,box-shadow] duration-300 ease-out-quart motion-reduce:transition-none"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          transform: `translateY(${shown ? (layout?.shift ?? 0) : 0}px) scale(${shown ? 1.025 : 1})`,
          boxShadow: shown ? "0 18px 40px -12px rgb(0 0 0 / 0.35), 0 0 0 1px rgb(0 0 0 / 0.04)" : "none",
        }}
      >
        {children}
      </div>

      <div
        ref={menuRef}
        role="menu"
        aria-label="Item actions"
        className={cn(
          "absolute w-60 max-w-[calc(100vw-24px)] overflow-hidden rounded-2xl border border-hairline bg-popover/95 p-1.5 text-popover-foreground shadow-2xl backdrop-blur-xl",
          "transition-[opacity,scale] duration-200 ease-out-quart motion-reduce:transition-none",
          shown ? "scale-100 opacity-100" : "scale-90 opacity-0",
        )}
        style={{
          top: layout?.top ?? 0,
          left: layout?.left ?? 0,
          visibility: layout ? undefined : "hidden",
          transformOrigin: layout?.above ? "bottom left" : "top left",
        }}
      >
        {actions.map((action, i) => {
          const Icon = action.icon
          return (
            <Fragment key={action.key}>
              {action.destructive && i > 0 ? <div role="separator" className="mx-2 my-1 h-px bg-hairline" /> : null}
              <button
                type="button"
                role="menuitem"
                onClick={() => dismiss(action.onSelect)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-3 text-left text-[0.95rem] font-medium outline-none transition-colors",
                  "hover:bg-foreground/5 focus-visible:bg-foreground/5 active:bg-foreground/10",
                  action.destructive && "text-destructive",
                )}
              >
                {action.label}
                <Icon className="size-[18px] shrink-0" />
              </button>
            </Fragment>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}
