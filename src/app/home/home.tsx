"use client"

import { useEffect, useState, type CSSProperties, type ReactNode } from "react"
import { Check, Plus, RotateCcw, SlidersHorizontal, X } from "lucide-react"
import { TabLoading } from "@/components/os/loading"
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core"
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { api } from "@/lib/api"
import type { HomeWidget } from "@/lib/data"
import { BottomSheet } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { cn } from "@/lib/utils"
import { DEFAULT_LAYOUT, WIDGETS, fitSizes, widgetDef } from "./widgets"
import { useClock24 } from "./widget-env"
import { HeaderSlot } from "@/components/ui/reusables/header-slot"
import { IconTile } from "@/components/ui/reusables/icon-tile"
import { useStore } from "@/lib/store"
import { isAwayOn, useAway } from "@/lib/away"
import { useSummer } from "@/lib/summer"
import { choreDone, choreDueOn, eventTimeLabel, expandEventsOn, pausesWhileAway, toISODate } from "@/lib/data"

/** Grid spans for each size on the 4-column home grid. */
const SPAN: Record<HomeWidget["size"], string> = {
  s: "col-span-1 row-span-1",
  m: "col-span-2 row-span-1",
  l: "col-span-2 row-span-2",
  full: "col-span-4 row-span-1",
}
const SIZE_LABEL: Record<HomeWidget["size"], string> = { s: "S", m: "M", l: "L", full: "Row" }
const SIZE_NAME: Record<HomeWidget["size"], string> = { s: "Small", m: "Wide", l: "Large", full: "Full row" }

const isField = (t: EventTarget) => t instanceof HTMLElement && !!t.closest("input, textarea, select")

const newId = () => `w-${Math.random().toString(36).slice(2, 9)}`

/**
 * The wall's home screen: widgets the family arranges themselves. Edit mode
 * lets anyone at the wall drag widgets around, resize them to the sizes each
 * one supports, add and remove them; the layout is saved on the hub.
 */
export function HomeView() {
  const [widgets, setWidgets] = useState<HomeWidget[] | null>(null)
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  const sensors = useSensors(
    // A few pixels of movement before a drag starts, so taps inside widgets still work.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  useEffect(() => {
    api.getHomeLayout()
      .then((layout) => setWidgets(fitSizes(layout?.widgets?.length ? layout.widgets : DEFAULT_LAYOUT)))
      .catch(() => setWidgets(DEFAULT_LAYOUT))
  }, [])

  const save = (next: HomeWidget[]) => {
    setWidgets(next)
    setSaveError(null)
    api.setHomeLayout({ widgets: next }).catch(() => setSaveError("Couldn't save the layout. Changes show here until the hub is back."))
  }

  const update = (id: string, patch: Partial<HomeWidget>) =>
    save(widgets!.map((w) => (w.id === id ? { ...w, ...patch } : w)))

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id))
  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null)
    const { active, over } = e
    if (!over || active.id === over.id || !widgets) return
    const from = widgets.findIndex((w) => w.id === active.id)
    const to = widgets.findIndex((w) => w.id === over.id)
    save(arrayMove(widgets, from, to))
  }

  if (!widgets) {
    return (
      <TabLoading tab="home" wall className="px-8 py-6" />
    )
  }

  const dragged = dragId ? widgets.find((w) => w.id === dragId) : null

  return (
    <div className={cn("space-y-5 px-8 py-6", editing && "pb-10")}>
      <HeaderSlot name="title">
        <HeaderClock />
      </HeaderSlot>

      {editing ? (
        <HeaderSlot name="extras">
          <button type="button" onClick={() => setConfirmReset(true)} className="os-button-quiet !min-h-11">
            <RotateCcw className="size-4" /> Reset
          </button>
          <button type="button" onClick={() => setAdding(true)} className="flex h-11 items-center gap-2 rounded-full bg-secondary px-4 text-sm font-medium">
            <Plus className="size-4" /> Add
          </button>
          <button type="button" onClick={() => setEditing(false)} className="flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">
            <Check className="size-4" /> Done
          </button>
        </HeaderSlot>
      ) : null}

      <div className="flex items-end gap-6">
        {editing ? (
          <p className="flex-1 text-muted-foreground">Drag a card to move it. Tap a size to resize it, or × to take it off the wall.</p>
        ) : (
          <Brief />
        )}
        {!editing ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex h-10 shrink-0 items-center gap-2 rounded-full border border-hairline bg-card px-4 text-sm font-medium text-muted-foreground"
          >
            <SlidersHorizontal className="size-4" /> Customize
          </button>
        ) : null}
      </div>
      {saveError ? <p className="text-sm text-destructive">{saveError}</p> : null}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
        <SortableContext items={widgets.map((w) => w.id)} strategy={rectSortingStrategy}>
          <div className="grid auto-rows-[minmax(11rem,auto)] grid-cols-4 gap-4">
            {widgets.map((w) => (
              <SortableTile
                key={w.id}
                widget={w}
                editing={editing}
                onConfig={(config) => update(w.id, { config: { ...w.config, ...config } })}
                onResize={(size) => update(w.id, { size })}
                onRemove={() => save(widgets.filter((x) => x.id !== w.id))}
              />
            ))}
          </div>
        </SortableContext>
        <DragOverlay dropAnimation={{ duration: 220, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }}>
          {dragged ? (
            <div className="h-full scale-[1.03] rounded-[20px] shadow-[0_24px_60px_-20px_oklch(0_0_0/0.6)] transition-transform duration-200">
              {widgetDef(dragged.type)?.render({ widget: dragged, editing: false, onConfig: () => {} })}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {widgets.length === 0 ? (
        <p className="py-16 text-center font-display text-3xl italic text-muted-foreground">
          An empty wall. Tap Customize, then Add.
        </p>
      ) : null}

      <BottomSheet open={adding} onClose={() => setAdding(false)} title="Add a card">
        <p className="-mt-1 text-sm text-muted-foreground">Pick what shows on the wall. Phones keep their own Home.</p>
        <div className="divide-y divide-hairline overflow-hidden rounded-[20px] border border-hairline bg-card">
          {WIDGETS.map((def) => {
            const on = widgets.some((w) => w.type === def.type)
            return (
              <button
                key={def.type}
                type="button"
                onClick={() => {
                  setAdding(false)
                  save([...widgets, { id: newId(), type: def.type, size: def.defaultSize }])
                }}
                className="flex min-h-[3.75rem] w-full items-center gap-3 px-4 py-2.5 text-left active:bg-secondary"
              >
                <IconTile icon={def.icon} tone="gray" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[0.95rem]">{def.label}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{def.description}</span>
                </span>
                {on ? <span className="os-label">On the wall</span> : <Plus className="size-4 text-muted-foreground" />}
              </button>
            )
          })}
        </div>
      </BottomSheet>

      <ConfirmDialog
        open={confirmReset}
        title="Reset the home screen?"
        message="Cards go back to the standard layout. Notes you wrote are cleared."
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => { setConfirmReset(false); save(DEFAULT_LAYOUT) }}
      />
    </div>
  )
}

/** The time, big, where other pages put their title. One clock per screen. */
function HeaderClock() {
  const clock24 = useClock24()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])
  return (
    <h1 className="font-display text-[3.6rem] leading-[0.85] tabular">
      {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: !clock24 })}
    </h1>
  )
}

const greeting = (h: number) => (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening")

/**
 * The day in one sentence, the phone's lead card, set big enough to read from
 * across the room: "Good morning. Leo has the Dentist at 10:30 AM, Ava has
 * Soccer practice at 4:00 PM, and Dad's making Tacos."
 */
function Brief() {
  const { events, meals, chores, getMember } = useStore()
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  const today = toISODate(now)
  const nowH = now.getHours() + now.getMinutes() / 60
  const paused = isAwayOn(useAway(), today)
  const summer = useSummer()

  const strong = (t: string) => <span className="text-foreground">{t}</span>
  const cap = (t: string, first: boolean) => (first ? t[0].toUpperCase() + t.slice(1) : t)
  const clauses: ((first: boolean) => ReactNode)[] = []

  const timed = expandEventsOn(events, today).filter((e) => !e.allDay && !e.endDate)
  const current = timed.find((e) => e.start <= nowH && e.end > nowH)
  const upcoming = timed.filter((e) => e.start > nowH).slice(0, current ? 1 : 2)
  const who = (ids: string[]) => (ids[0] ? getMember(ids[0]).name : null)
  if (current) {
    const w = who(current.memberIds)
    clauses.push((first) => (
      <>{w ? `${w} has ` : cap("there's ", first)}{strong(current.title)} until {strong(eventTimeLabel({ ...current, start: current.end }, today))}</>
    ))
  }
  for (const e of upcoming) {
    const w = who(e.memberIds)
    clauses.push((first) => <>{w ? `${w} has ` : cap("there's ", first)}{strong(e.title)} at {strong(eventTimeLabel(e, today))}</>)
  }

  const weekday = now.toLocaleDateString("en-US", { weekday: "short" })
  const dinner =
    meals.find((m) => m.date === today && /dinner/i.test(m.type)) ??
    meals.find((m) => !m.date && m.day === weekday && /dinner/i.test(m.type))
  if (dinner) {
    const cook = dinner.memberId ? getMember(dinner.memberId).name : null
    clauses.push((first) => (cook ? <>{cook}&rsquo;s making {strong(dinner.name)}</> : <>{cap("dinner is", first)} {strong(dinner.name)}</>))
  }

  const left = chores.filter((c) => choreDueOn(c, now, summer) && !(paused && pausesWhileAway(c)) && !choreDone(c, today)).length
  if (left && clauses.length < 4) clauses.push((first) => <>{cap("there", first)} {left === 1 ? "is" : "are"} {strong(`${left} ${left === 1 ? "chore" : "chores"}`)} left</>)

  return (
    <p className="flex-1 text-pretty font-display text-[2.15rem] leading-[1.12] text-muted-foreground">
      {greeting(now.getHours())}.{" "}
      {clauses.length === 0 ? (
        "Nothing else on today."
      ) : (
        <>
          {clauses[0](true)}
          {clauses.slice(1).map((c, i) => (
            <span key={i}>{i === clauses.length - 2 ? (clauses.length > 2 ? ", and " : " and ") : ", "}{c(false)}</span>
          ))}
          .
        </>
      )}
    </p>
  )
}

function SortableTile({
  widget,
  editing,
  onConfig,
  onResize,
  onRemove,
}: {
  widget: HomeWidget
  editing: boolean
  onConfig: (config: Record<string, unknown>) => void
  onResize: (size: HomeWidget["size"]) => void
  onRemove: () => void
}) {
  const def = widgetDef(widget.type)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id, disabled: !editing })
  if (!def) return null
  const style: CSSProperties = {
    transform: CSS.Translate.toString(transform),
    transition: transition ?? "transform 250ms cubic-bezier(0.2, 0.8, 0.2, 1)",
  }
  return (
    <div
      ref={setNodeRef}
      style={style}
      {...(editing ? { ...attributes, ...listeners } : {})}
      className={cn(
        "relative min-w-0 rounded-[20px]",
        SPAN[widget.size],
        editing && "cursor-grab touch-none outline-dashed outline-[1.5px] outline-offset-4 outline-border active:cursor-grabbing",
        isDragging && "opacity-30",
      )}
    >
      <div
        className={cn("h-full transition-transform duration-200", editing && "scale-[0.985]")}
        // Typing or picking in a widget's own fields (note, list, town) must not start a drag.
        onPointerDown={(e) => isField(e.target) && e.stopPropagation()}
        onKeyDown={(e) => isField(e.target) && e.stopPropagation()}
      >
        {def.render({ widget, editing, onConfig })}
      </div>
      {editing ? (
        <>
          <button
            type="button"
            aria-label={`Remove ${def.label}`}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onRemove}
            className="hit absolute -left-3 -top-3 flex size-9 items-center justify-center rounded-full border border-hairline bg-popover text-foreground shadow-sm animate-in zoom-in-50 duration-200"
          >
            <X className="size-4" />
          </button>
          {def.sizes.length > 1 ? (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute bottom-2.5 right-2.5 flex gap-0.5 rounded-full border border-hairline bg-popover p-1 shadow-sm animate-in fade-in duration-200"
            >
              {def.sizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-label={`${SIZE_NAME[size]} size`}
                  aria-pressed={widget.size === size}
                  onClick={() => onResize(size)}
                  className={cn(
                    "h-9 min-w-9 rounded-full px-2.5 text-xs font-semibold transition-colors",
                    widget.size === size ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {SIZE_LABEL[size]}
                </button>
              ))}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
