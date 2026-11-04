import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { ArrowBigUp, ChevronDown, Delete } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Solora's on-screen keyboard.
 *
 * The kiosk has no desktop and no OS keyboard, so any text field focused by a
 * finger raises this. It types into the focused element with the native value
 * setter + an `input` event (so React state updates as if typed), lifts the
 * app so the field sits just above the keys, and keeps focus on the field —
 * keys act on pointerdown and never steal it.
 *
 * Mode (localStorage "solora-osk"): "auto" (production default — only after a
 * touch/pen tap), "always" (dev default), or "never".
 */

type Field = HTMLInputElement | HTMLTextAreaElement
type Page = "letters" | "symbols"

const TEXT_TYPES = new Set(["text", "email", "password", "search", "url", "tel", "number", ""])

const LETTERS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
]
const SYMBOLS = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["-", "/", ":", ";", "(", ")", "$", "&", "@", "\""],
  [".", ",", "?", "!", "'", "_", "#", "%", "+"],
]

function isField(el: Element | null): el is Field {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) {
    return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled && el.dataset.osk !== "off"
  }
  return false
}

function mode(): "auto" | "always" | "never" {
  // Dev builds (e.g. `npm run dev` on a Mac) default to "always" so the
  // keyboard can be tested with a mouse; production stays "auto".
  const fallback = import.meta.env.DEV ? "always" : "auto"
  try {
    const m = localStorage.getItem("solora-osk")
    return m === "always" || m === "never" || m === "auto" ? m : fallback
  } catch {
    return fallback
  }
}

/** Set a value the way React expects (bypasses its value tracker). */
function setNativeValue(el: Field, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, value)
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

/** email / number inputs don't expose a selection — treat them as append-only. */
function selection(el: Field): [number, number] {
  try {
    if (el.selectionStart != null && el.selectionEnd != null) return [el.selectionStart, el.selectionEnd]
  } catch {
    /* unsupported type */
  }
  return [el.value.length, el.value.length]
}

function insert(el: Field, text: string) {
  const [a, b] = selection(el)
  const max = el.maxLength > 0 ? el.maxLength : Infinity
  const next = (el.value.slice(0, a) + text + el.value.slice(b)).slice(0, max)
  setNativeValue(el, next)
  try {
    el.setSelectionRange(a + text.length, a + text.length)
  } catch {
    /* unsupported type */
  }
}

function backspace(el: Field) {
  const [a, b] = selection(el)
  if (a === 0 && b === 0) return
  const from = a === b ? a - 1 : a
  setNativeValue(el, el.value.slice(0, from) + el.value.slice(b))
  try {
    el.setSelectionRange(from, from)
  } catch {
    /* unsupported type */
  }
}

/** The next focusable text field in the same form, for a "Next" key. */
function nextField(el: Field): Field | null {
  const form = el.form
  if (!form) return null
  const fields = Array.from(form.elements).filter((f): f is Field => isField(f as Element))
  const i = fields.indexOf(el)
  return i >= 0 ? fields[i + 1] ?? null : null
}

// ── Key ─────────────────────────────────────────────────────────────────────

function Key({
  children,
  onPress,
  grow = 1,
  tone = "char",
  repeat = false,
  label,
  active,
}: {
  children: React.ReactNode
  onPress: () => void
  grow?: number
  tone?: "char" | "fn" | "go"
  repeat?: boolean
  label?: string
  active?: boolean
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const interval = useRef<ReturnType<typeof setInterval> | null>(null)
  const [down, setDown] = useState(false)

  const stop = () => {
    setDown(false)
    if (timer.current) clearTimeout(timer.current)
    if (interval.current) clearInterval(interval.current)
  }
  useEffect(() => stop, [])

  return (
    <button
      type="button"
      aria-label={label}
      data-hold
      tabIndex={-1}
      onPointerDown={(e) => {
        e.preventDefault() // keep focus in the field
        setDown(true)
        onPress()
        if (repeat) {
          timer.current = setTimeout(() => {
            interval.current = setInterval(onPress, 60)
          }, 420)
        }
      }}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onContextMenu={(e) => e.preventDefault()}
      style={{ flexGrow: grow, flexBasis: 0 }}
      className={cn(
        "relative flex h-[3.6rem] min-w-0 select-none items-center justify-center rounded-md text-[1.35rem] transition-[background-color,transform] duration-75 touch-none",
        tone === "char" && "bg-card text-foreground shadow-[0_1px_0_var(--border)]",
        tone === "fn" && "bg-secondary text-muted-foreground text-base",
        tone === "go" && "bg-foreground text-background text-base font-medium",
        active && "bg-foreground text-background",
        down && "scale-[0.96] bg-accent",
        down && tone === "go" && "bg-foreground/80",
      )}
    >
      {tone === "go" ? <span className="absolute left-3 top-1/2 size-1 -translate-y-1/2 rounded-full bg-season" /> : null}
      {children}
    </button>
  )
}

// ── Keyboard ────────────────────────────────────────────────────────────────

export function TouchKeyboard() {
  const [target, setTarget] = useState<Field | null>(null)
  const [page, setPage] = useState<Page>("letters")
  const [shift, setShift] = useState<"off" | "once" | "lock">("off")
  const lastPointer = useRef<string>("mouse")
  const lastShiftTap = useRef(0)
  const panel = useRef<HTMLDivElement>(null)

  // Remember how the user last touched the screen.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      lastPointer.current = e.pointerType
    }
    // A long press on a touchscreen fires `contextmenu` — there is no desktop
    // menu worth showing on a wall display, so swallow it (mouse still works).
    const onMenu = (e: MouseEvent) => {
      if (lastPointer.current !== "mouse") e.preventDefault()
    }
    window.addEventListener("pointerdown", onDown, true)
    window.addEventListener("contextmenu", onMenu)
    return () => {
      window.removeEventListener("pointerdown", onDown, true)
      window.removeEventListener("contextmenu", onMenu)
    }
  }, [])

  // Open on focus of a text field; close when focus leaves all fields.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element
      if (!isField(el)) return
      const m = mode()
      if (m === "never" || (m === "auto" && lastPointer.current === "mouse")) return
      setTarget(el)
      // Ours replaces the system keyboard (Android would raise its own too).
      el.inputMode = "none"
      setPage(el instanceof HTMLInputElement && (el.type === "number" || el.type === "tel") ? "symbols" : "letters")
      // Capitalise the first letter of names/titles, not emails/passwords/codes.
      const auto =
        el instanceof HTMLInputElement &&
        el.type === "text" &&
        el.value.length === 0 &&
        !/uppercase|font-mono/.test(el.className)
      setShift(auto ? "once" : "off")
    }
    const onFocusOut = () => {
      setTimeout(() => {
        if (!isField(document.activeElement)) setTarget(null)
      }, 80)
    }
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("focusout", onFocusOut)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("focusout", onFocusOut)
    }
  }, [])

  // Lift the app so the focused field clears the keyboard.
  useLayoutEffect(() => {
    const root = document.getElementById("root")
    if (!root) return
    if (!target || !panel.current) {
      root.style.transform = ""
      return
    }
    target.scrollIntoView({ block: "nearest" })
    root.style.transition = "transform 260ms cubic-bezier(0.25, 1, 0.5, 1)"
    root.style.transform = ""
    const kb = panel.current.getBoundingClientRect().height
    const r = target.getBoundingClientRect()
    const lift = Math.max(0, r.bottom + 24 - (window.innerHeight - kb))
    root.style.transform = lift ? `translateY(${-lift}px)` : ""
    return () => {
      root.style.transform = ""
    }
  }, [target])

  const type = useCallback(
    (ch: string) => {
      if (!target) return
      const upper = shift !== "off" && page === "letters"
      insert(target, upper ? ch.toUpperCase() : ch)
      if (shift === "once") setShift("off")
    },
    [target, shift, page],
  )

  const enter = useCallback(() => {
    if (!target) return
    if (target instanceof HTMLTextAreaElement) {
      insert(target, "\n")
      return
    }
    const next = nextField(target)
    if (next) {
      next.focus()
      return
    }
    const ev = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })
    const handled = !target.dispatchEvent(ev)
    if (!handled && target.form) target.form.requestSubmit()
    if (!target.form) target.blur()
  }, [target])

  if (!target) return null

  const isEmail = target instanceof HTMLInputElement && target.type === "email"
  const goLabel = target instanceof HTMLTextAreaElement ? "Return" : nextField(target) ? "Next" : target.form ? "Go" : "Done"
  const rows = page === "letters" ? LETTERS : SYMBOLS
  const upper = shift !== "off" && page === "letters"

  return createPortal(
    <div
      ref={panel}
      role="group"
      aria-label="On-screen keyboard"
      onPointerDown={(e) => e.preventDefault()}
      className="rise-in fixed inset-x-0 bottom-0 z-[9000] border-t border-border bg-popover/95 pb-3 pt-2 backdrop-blur-md"
    >
      <div className="mx-auto flex max-w-[62rem] flex-col gap-2 px-3">
        <div className="flex items-center justify-between px-1">
          <span className="os-label truncate">
            {target.getAttribute("aria-label") ||
              target.labels?.[0]?.querySelector(".os-label")?.textContent ||
              target.labels?.[0]?.textContent ||
              target.placeholder ||
              "Keyboard"}
          </span>
          <button
            type="button"
            data-hold
            tabIndex={-1}
            aria-label="Hide keyboard"
            onPointerDown={(e) => {
              e.preventDefault()
              target.blur()
              setTarget(null)
            }}
            className="flex h-10 w-14 items-center justify-center rounded-md text-muted-foreground"
          >
            <ChevronDown className="size-5" />
          </button>
        </div>

        {rows.map((row, i) => (
          <div key={i} className="flex gap-2" style={{ paddingInline: i === 1 && page === "letters" ? "4.5%" : 0 }}>
            {i === 2 ? (
              page === "letters" ? (
                <Key
                  tone="fn"
                  grow={1.5}
                  label="Shift"
                  active={shift !== "off"}
                  onPress={() => {
                    const now = Date.now()
                    if (shift === "once" && now - lastShiftTap.current < 350) setShift("lock")
                    else setShift(shift === "off" ? "once" : "off")
                    lastShiftTap.current = now
                  }}
                >
                  <ArrowBigUp className={cn("size-6", shift === "lock" && "fill-current")} />
                </Key>
              ) : (
                <Key tone="fn" grow={1.5} onPress={() => setPage("letters")}>
                  ABC
                </Key>
              )
            ) : null}
            {row.map((k) => (
              <Key key={k} onPress={() => type(k)}>
                {upper ? k.toUpperCase() : k}
              </Key>
            ))}
            {i === 2 ? (
              <Key tone="fn" grow={1.5} label="Delete" repeat onPress={() => target && backspace(target)}>
                <Delete className="size-6" />
              </Key>
            ) : null}
          </div>
        ))}

        <div className="flex gap-2">
          <Key tone="fn" grow={1.5} onPress={() => setPage(page === "letters" ? "symbols" : "letters")}>
            {page === "letters" ? "123" : "ABC"}
          </Key>
          {isEmail ? (
            <>
              <Key onPress={() => type("@")}>@</Key>
              <Key tone="fn" grow={1.2} onPress={() => target && insert(target, ".com")}>
                .com
              </Key>
            </>
          ) : (
            <Key onPress={() => type(",")}>,</Key>
          )}
          <Key grow={isEmail ? 4 : 5.2} label="Space" onPress={() => type(" ")}>
            <span className="h-1 w-16 rounded-full bg-border" />
          </Key>
          <Key onPress={() => type(".")}>.</Key>
          <Key tone="go" grow={2} onPress={enter}>
            {goLabel}
          </Key>
        </div>
      </div>
    </div>,
    document.body,
  )
}
