"use client"

import { useEffect, useState } from "react"
import { CalendarPlus, Plus } from "lucide-react"
import type { Meal } from "@/lib/data"
import { cn } from "@/lib/utils"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { ActionRow } from "@/components/ui/reusables/action-row"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { useHighlight, useStore } from "@/lib/store"
import { MenuFieldsEditor, SpecialDays, WeekGroceries, emptyMenuFields, menuFieldsFrom, menuPayload, weekdayOf, type MenuFields } from "./holiday-menus"

// Kept identical in kiosk/ and mobile/.

const DAY_ABBR = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MEAL_TYPES = ["Breakfast", "Lunch", "Dinner", "Snack"]

type FormState = {
  day: string
  type: string
  name: string
  memberId: string
  repeatDays: string[]
  menu: MenuFields
}

/** The next seven days starting today, so the week always reads from now. */
function upcomingDays(): { abbr: string; date: Date; label: string }[] {
  return Array.from({ length: 7 }, (_, i) => {
    const date = new Date()
    date.setDate(date.getDate() + i)
    const abbr = DAY_ABBR[(date.getDay() + 6) % 7]
    const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : date.toLocaleDateString(undefined, { weekday: "long" })
    return { abbr, date, label }
  })
}

/**
 * The week's menu as one card per day, starting today. Tap a meal to edit it;
 * long-press (or swipe) for edit and delete; + on a day plans the next free meal.
 */
export function MealsView() {
  const { meals, members, getMember, can, addMeal, updateMeal, deleteMeal, addEvent } = useStore()
  const canManage = can("meals")
  const { highlight, register, clearHighlight, refs } = useHighlight("meals")

  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Meal | null>(null)
  const [form, setForm] = useState<FormState>({ day: "Mon", type: "Dinner", name: "", memberId: "", repeatDays: [], menu: emptyMenuFields() })
  const [deleteId, setDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (!highlight) return
    const el = refs.get(highlight.id)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("highlight-flash")
    const t = setTimeout(() => { el.classList.remove("highlight-flash"); clearHighlight() }, 2000)
    return () => clearTimeout(t)
  }, [highlight, refs, clearHighlight])

  const weekly = meals.filter((m) => !m.date)
  const slotTaken = (day: string, type: string, except?: string) =>
    weekly.some((m) => m.day === day && m.type === type && m.id !== except)

  const openAdd = (day: string) => {
    if (!canManage) return
    setEditing(null)
    // Dinner first; it's the one families actually plan.
    const type = ["Dinner", ...MEAL_TYPES].find((t) => !slotTaken(day, t)) ?? "Dinner"
    setForm({ day, type, name: "", memberId: "", repeatDays: [], menu: emptyMenuFields() })
    setSheetOpen(true)
  }

  const openEdit = (m: Meal) => {
    if (!canManage) return
    setEditing(m)
    setForm({ day: m.day, type: m.type, name: m.name, memberId: m.memberId ?? "", repeatDays: [], menu: menuFieldsFrom(m) })
    setSheetOpen(true)
  }

  const save = () => {
    if (!form.name.trim()) return
    const menu = menuPayload(form.menu)
    const payload = {
      day: menu.date ? weekdayOf(menu.date) : form.day,
      type: form.type,
      name: form.name.trim(),
      memberId: form.memberId,
      ...menu,
    }
    if (editing) {
      updateMeal(editing.id, payload)
    } else if (menu.date) {
      // A one-date menu takes no weekly slot and doesn't repeat to other days.
      addMeal(payload)
    } else {
      // One meal per weekly (day, type) slot: replace what's there.
      for (const day of [form.day, ...form.repeatDays.filter((d) => d !== form.day)]) {
        const existing = weekly.find((m) => m.day === day && m.type === form.type)
        if (existing) updateMeal(existing.id, { ...payload, day })
        else addMeal({ ...payload, day })
      }
    }
    setSheetOpen(false)
  }

  const addToCalendar = (meal: Meal) => {
    const day = upcomingDays().find((d) => d.abbr === meal.day)
    if (!day) return
    const d = day.date
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    addEvent({ title: `🍽 ${meal.name}`, date, time: "18:00", start: 18, end: 19, memberIds: meal.memberId ? [meal.memberId] : [], calendarId: "", location: undefined })
    setSheetOpen(false)
  }

  const deleting = deleteId ? meals.find((m) => m.id === deleteId) : null

  return (
    <div className="space-y-5 px-4 py-4">
      <SpecialDays onOpen={openEdit} />

      <div className="flex flex-wrap items-center justify-between gap-x-4 px-1">
        <p className="text-sm text-muted-foreground">
          {weekly.length === 0 ? "Nothing planned yet" : `${weekly.length} ${weekly.length === 1 ? "meal" : "meals"} planned`}
          {canManage ? " · hold a meal to change it" : ""}
        </p>
        <WeekGroceries />
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {upcomingDays().map(({ abbr, date, label }, i) => {
          const items = MEAL_TYPES.flatMap((t) => weekly.filter((m) => m.day === abbr && m.type === t))
          const full = MEAL_TYPES.every((t) => slotTaken(abbr, t))
          return (
            <section key={abbr} className={cn("overflow-hidden rounded-lg bg-card", i === 0 && "ring-1 ring-season/50")}>
              <header className="flex items-center gap-2 py-2 pl-4 pr-1.5">
                <h2 className="font-display text-2xl leading-none">{label}</h2>
                <span className="text-sm text-muted-foreground tabular">
                  {date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                </span>
                {canManage && !full ? (
                  <button
                    type="button"
                    onClick={() => openAdd(abbr)}
                    aria-label={`Plan a meal for ${label}`}
                    className="ml-auto flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors active:bg-secondary hover:text-foreground"
                  >
                    <Plus className="size-5" />
                  </button>
                ) : <span className="h-11" />}
              </header>

              {items.length === 0 ? (
                <button
                  type="button"
                  disabled={!canManage}
                  onClick={() => openAdd(abbr)}
                  className="block w-full px-4 pb-4 text-left text-sm text-muted-foreground"
                >
                  {canManage ? "Nothing planned — tap to add" : "Nothing planned"}
                </button>
              ) : (
                <ul className="divide-y divide-hairline border-t border-hairline">
                  {items.map((meal) => {
                    const cook = meal.memberId ? getMember(meal.memberId) : null
                    return (
                      <li key={meal.id} ref={register(meal.id)}>
                        <ActionRow
                          rounded=""
                          onEdit={canManage ? () => openEdit(meal) : undefined}
                          onDelete={canManage ? () => setDeleteId(meal.id) : undefined}
                        >
                          <button
                            type="button"
                            onClick={() => openEdit(meal)}
                            className="flex min-h-14 w-full items-center gap-3 bg-card px-4 py-2.5 text-left"
                          >
                            <span className="w-[4.75rem] shrink-0 text-xs font-medium text-muted-foreground">{meal.type}</span>
                            <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{meal.name}</span>
                            {cook ? <MemberAvatar member={cook} size="sm" /> : null}
                          </button>
                        </ActionRow>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={editing ? "Edit meal" : "Plan a meal"}
        footer={
          <div className="flex gap-2">
            {editing && !editing.date ? (
              <button
                type="button"
                onClick={() => addToCalendar(editing)}
                className="flex items-center gap-2 rounded-md bg-secondary px-4 py-3 text-sm font-semibold"
              >
                <CalendarPlus className="size-4" />
                Add to calendar
              </button>
            ) : null}
            <button
              type="button"
              onClick={save}
              className="flex-1 rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              {editing ? "Save changes" : "Add meal"}
            </button>
          </div>
        }
      >
        <Field label="Dish">
          <input
            autoFocus
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Taco night"
            className={inputClass}
          />
        </Field>
        <MenuFieldsEditor value={form.menu} onChange={(menu) => setForm((f) => ({ ...f, menu }))} />

        <div className="flex gap-3">
          {form.menu.onDate ? null : (
            <Field label="Day">
              <select value={form.day} onChange={(e) => setForm((f) => ({ ...f, day: e.target.value }))} className={inputClass}>
                {DAY_ABBR.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </Field>
          )}
          <Field label="Meal">
            <select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className={inputClass}>
              {MEAL_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}{!form.menu.onDate && slotTaken(form.day, t, editing?.id) ? " (replaces)" : ""}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Cook">
          <select value={form.memberId} onChange={(e) => setForm((f) => ({ ...f, memberId: e.target.value }))} className={inputClass}>
            <option value="">No one assigned</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>

        {!editing && !form.menu.onDate ? (
          <div>
            <span className="mb-2 block text-xs font-semibold text-muted-foreground">Also on</span>
            <div className="flex flex-wrap gap-2">
              {DAY_ABBR.filter((d) => d !== form.day).map((d) => {
                const on = form.repeatDays.includes(d)
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setForm((f) => ({ ...f, repeatDays: on ? f.repeatDays.filter((x) => x !== d) : [...f.repeatDays, d] }))
                    }
                    className={cn(
                      "h-10 min-w-12 rounded-full border px-3 text-sm font-medium transition-colors",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
                    )}
                  >
                    {d}
                  </button>
                )
              })}
            </div>
          </div>
        ) : null}
      </BottomSheet>

      <ConfirmDialog
        open={!!deleteId}
        title="Delete meal?"
        message={deleting ? `“${deleting.name}” will be removed.` : ""}
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) deleteMeal(deleteId)
          setDeleteId(null)
        }}
      />
    </div>
  )
}
