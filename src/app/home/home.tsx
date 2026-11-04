"use client"

import { useEffect, useState, type CSSProperties } from "react"
import { Check, LayoutGrid, Plus, RotateCcw, X } from "lucide-react"
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
    <div className={cn("space-y-4 px-8 py-6", editing && "pb-28")}>
      <div className="flex min-h-9 items-center justify-end gap-2">
        {saveError ? <p className="mr-auto text-sm text-destructive">{saveError}</p> : null}
        {editing ? (
          <p className="mr-auto text-sm text-muted-foreground">Drag widgets to move them. Tap a size to resize.</p>
        ) : (
          <button type="button" onClick={() => setEditing(true)}
            className="flex h-9 items-center gap-2 rounded-full px-3 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
            <LayoutGrid className="size-4" /> Edit
          </button>
        )}
      </div>

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
            <div className="h-full scale-[1.03] rounded-lg shadow-[0_24px_60px_-20px_oklch(0_0_0/0.6)] transition-transform duration-200">
              {widgetDef(dragged.type)?.render({ widget: dragged, editing: false, onConfig: () => {} })}
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {widgets.length === 0 ? (
        <p className="py-16 text-center font-display text-3xl italic text-muted-foreground">
          An empty wall. Tap Edit, then Add.
        </p>
      ) : null}

      {/* Edit bar: small, floating, out of the way of the widgets. */}
      {editing ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-hairline bg-popover/95 p-1.5 shadow-[0_16px_40px_-16px_oklch(0_0_0/0.5)] ios-blur animate-in fade-in slide-in-from-bottom-4 duration-300">
            <button type="button" onClick={() => setAdding(true)}
              className="flex h-11 items-center gap-2 rounded-full px-4 text-sm font-medium transition-colors hover:bg-secondary">
              <Plus className="size-4" /> Add
            </button>
            <button type="button" onClick={() => setConfirmReset(true)} aria-label="Reset layout"
              className="flex size-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
              <RotateCcw className="size-4" />
            </button>
            <button type="button" onClick={() => setEditing(false)}
              className="flex h-11 items-center gap-2 rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground">
              <Check className="size-4" /> Done
            </button>
          </div>
        </div>
      ) : null}

      <BottomSheet open={adding} onClose={() => setAdding(false)} title="Add a widget">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          {WIDGETS.map((def) => (
            <button key={def.type} type="button"
              onClick={() => {
                setAdding(false)
                save([...widgets, { id: newId(), type: def.type, size: def.defaultSize }])
              }}
              className="flex flex-col items-start gap-2 rounded-lg bg-card p-3.5 text-left transition-colors hover:bg-secondary active:scale-[0.98]">
              <def.icon className="size-5 text-season" strokeWidth={1.6} />
              <span className="block font-medium leading-tight">{def.label}</span>
              <span className="block text-xs text-muted-foreground">{def.description}</span>
            </button>
          ))}
        </div>
      </BottomSheet>

      <ConfirmDialog
        open={confirmReset}
        title="Reset the home screen?"
        message="Widgets go back to the standard layout. Notes you wrote are cleared."
        confirmLabel="Reset"
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => { setConfirmReset(false); save(DEFAULT_LAYOUT) }}
      />
    </div>
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
        "relative min-w-0 rounded-lg",
        SPAN[widget.size],
        editing && "cursor-grab touch-none ring-1 ring-season/40 active:cursor-grabbing",
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
            className="absolute -left-2 -top-2 flex size-8 items-center justify-center rounded-full border border-hairline bg-popover text-muted-foreground shadow-sm transition-colors hover:text-destructive animate-in zoom-in-50 duration-200"
          >
            <X className="size-4" />
          </button>
          {def.sizes.length > 1 ? (
            <div
              onPointerDown={(e) => e.stopPropagation()}
              className="absolute bottom-2 right-2 flex gap-0.5 rounded-full border border-hairline bg-popover/95 p-0.5 shadow-sm animate-in fade-in duration-200"
            >
              {def.sizes.map((size) => (
                <button
                  key={size}
                  type="button"
                  aria-label={`${SIZE_NAME[size]} size`}
                  aria-pressed={widget.size === size}
                  onClick={() => onResize(size)}
                  className={cn(
                    "h-8 min-w-8 rounded-full px-2 text-xs font-semibold transition-colors",
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
