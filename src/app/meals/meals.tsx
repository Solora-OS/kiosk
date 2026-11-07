"use client"

import { useEffect, useState } from "react"
import { CalendarPlus, Trash2 } from "lucide-react"
import type { Meal } from "@/lib/data"
import { cn } from "@/lib/utils"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { BottomSheet, ChoiceChips, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { HeaderSlot } from "@/components/ui/reusables/header-slot"
import { HeaderAdd } from "@/components/ui/reusables/header-add"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { useHighlight, useStore } from "@/lib/store"
import { MenuFieldsEditor, SpecialDays, WeekGroceries, emptyMenuFields, menuFieldsFrom, menuPayload, weekdayOf, type MenuFields } from "./holiday-menus"


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
 * The week's menu as a strip of seven days, starting today. Tap a meal to
 * change or delete it; tap an empty slot to plan one.
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

  const days = upcomingDays()

  return (
    <div className="flex flex-1 flex-col gap-4">
      <HeaderSlot name="extras">
        <WeekGroceries />
      </HeaderSlot>
      {canManage ? <HeaderAdd label="Plan a meal" onClick={() => openAdd(days[0].abbr)} /> : null}
      <SpecialDays onOpen={openEdit} />

      {/* The week as a strip, starting today. Tonight is ringed; dinner names are set in serif. */}
      <div className="grid min-h-[30rem] flex-1 grid-cols-7 gap-2.5">
        {days.map(({ abbr, date, label }, i) => {
          // Snacks only show when someone planned one.
          const types = MEAL_TYPES.filter((t) => t !== "Snack" || weekly.some((m) => m.day === abbr && m.type === t))
          return (
            <section
              key={abbr}
              className={cn(
                "flex min-w-0 flex-col overflow-hidden rounded-[20px] border bg-card",
                i === 0 ? "border-foreground shadow-[inset_0_0_0_0.5px_var(--foreground)]" : "border-hairline",
              )}
            >
              <header className="px-3 pb-2.5 pt-3">
                <h2 className="truncate font-display text-[1.65rem] leading-none">{i === 0 ? "Tonight" : label}</h2>
                <p className="os-label mt-1.5">{date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</p>
              </header>
              {types.map((t) => {
                const meal = weekly.find((m) => m.day === abbr && m.type === t)
                const cook = meal?.memberId ? getMember(meal.memberId) : null
                const dinner = t === "Dinner"
                return (
                  <button
                    key={t}
                    ref={meal ? register(meal.id) : undefined}
                    type="button"
                    disabled={!canManage}
                    onClick={() => {
                      if (meal) openEdit(meal)
                      else {
                        openAdd(abbr)
                        setForm((f) => ({ ...f, type: t }))
                      }
                    }}
                    className={cn(
                      "flex w-full min-w-0 flex-col items-start gap-1 border-t border-hairline px-3 py-2.5 text-left active:bg-secondary disabled:active:bg-transparent",
                      dinner && "flex-1",
                    )}
                  >
                    <span className="os-label !text-[0.62rem]">{t}</span>
                    {meal ? (
                      <span className={cn("line-clamp-3 min-w-0", dinner ? "font-display text-[1.45rem] leading-[1.05]" : "text-[0.9rem] leading-snug")}>
                        {meal.name}
                      </span>
                    ) : (
                      <span className="text-[0.82rem] text-muted-foreground/80">{canManage ? `+ Plan` : "—"}</span>
                    )}
                    {cook ? (
                      <span className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", dinner && "mt-auto pt-1")}>
                        <MemberAvatar member={cook} size="sm" className="size-5 text-[0.6rem]" />
                        {dinner ? `${cook.name} cooks` : cook.name}
                      </span>
                    ) : null}
                  </button>
                )
              })}
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
            {editing ? (
              <button
                type="button"
                aria-label="Delete meal"
                onClick={() => {
                  setSheetOpen(false)
                  setDeleteId(editing.id)
                }}
                className="flex size-14 shrink-0 items-center justify-center rounded-full bg-secondary text-destructive"
              >
                <Trash2 className="size-5" />
              </button>
            ) : null}
            {editing && !editing.date ? (
              <button
                type="button"
                onClick={() => addToCalendar(editing)}
                className="flex items-center gap-2 rounded-full bg-secondary px-5 text-sm font-semibold"
              >
                <CalendarPlus className="size-4" />
                Add to calendar
              </button>
            ) : null}
            <button
              type="button"
              onClick={save}
              className="os-button flex-1"
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

        {form.menu.onDate ? null : (
          <div>
            <span className="os-label mb-2 block">Day</span>
            <ChoiceChips value={form.day} onChange={(day) => setForm((f) => ({ ...f, day }))} options={DAY_ABBR.map((d) => ({ value: d, label: d }))} />
          </div>
        )}
        <div>
          <span className="os-label mb-2 block">Meal</span>
          <ChoiceChips
            value={form.type}
            onChange={(type) => setForm((f) => ({ ...f, type }))}
            options={MEAL_TYPES.map((t) => ({ value: t, label: t }))}
          />
          {!form.menu.onDate && slotTaken(form.day, form.type, editing?.id) ? (
            <span className="mt-2 block text-xs text-muted-foreground">Replaces what&apos;s planned for {form.day} {form.type.toLowerCase()}.</span>
          ) : null}
        </div>

        <div>
          <span className="os-label mb-2 block">Cook</span>
          <ChoiceChips
            value={form.memberId}
            onChange={(memberId) => setForm((f) => ({ ...f, memberId }))}
            options={[
              { value: "", label: "No one" },
              ...members.filter((m) => m.id !== "family").map((m) => ({ value: m.id, label: m.name, lead: <MemberAvatar member={m} size="sm" /> })),
            ]}
          />
        </div>

        {!editing && !form.menu.onDate ? (
          <div>
            <span className="os-label mb-2 block">Also on</span>
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
                      "h-11 min-w-12 rounded-full border px-4 text-sm font-medium transition-colors",
                      on ? "border-transparent bg-foreground text-background" : "border-hairline bg-card text-foreground",
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
