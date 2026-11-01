"use client"

import { useState } from "react"
import { CalendarHeart, ShoppingBasket } from "lucide-react"
import { api } from "@/lib/api"
import { type Meal, toISODate } from "@/lib/data"
import { useStore } from "@/lib/store"
import { Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { cn } from "@/lib/utils"

/**
 * Holiday menus: meals for one specific day (Christmas Eve tamales) instead of
 * every week, and ingredients that go straight onto the grocery list. Kept
 * identical in mobile/ and kiosk/; each meals screen adds these pieces.
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
export const weekdayOf = (iso: string) => DAYS[new Date(`${iso}T00:00:00`).getDay()]
const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })

/** The extra fields in the meal form. */
export type MenuFields = { onDate: boolean; date: string; ingredients: string }

export const emptyMenuFields = (): MenuFields => ({ onDate: false, date: toISODate(new Date()), ingredients: "" })

export const menuFieldsFrom = (m: Meal): MenuFields => ({
  onDate: !!m.date,
  date: m.date ?? toISODate(new Date()),
  ingredients: (m.ingredients ?? []).join("\n"),
})

/** What to send with the meal: a date (or null for weekly) and the ingredient lines. */
export function menuPayload(f: MenuFields): { date: string | null; ingredients: string[] } {
  return {
    date: f.onDate ? f.date : null,
    ingredients: f.ingredients.split("\n").map((l) => l.trim()).filter(Boolean),
  }
}

export function MenuFieldsEditor({ value, onChange }: { value: MenuFields; onChange: (v: MenuFields) => void }) {
  return (
    <>
      <Field label="When">
        <div className="flex gap-2">
          {[false, true].map((onDate) => (
            <button
              key={String(onDate)}
              type="button"
              aria-pressed={value.onDate === onDate}
              onClick={() => onChange({ ...value, onDate })}
              className={cn(
                "flex-1 rounded-md py-2 text-sm font-medium transition-colors",
                value.onDate === onDate ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
              )}
            >
              {onDate ? "One date" : "Every week"}
            </button>
          ))}
        </div>
      </Field>
      {value.onDate ? (
        <Field label="Date">
          <input type="date" value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} className={inputClass} />
        </Field>
      ) : null}
      <Field label="Ingredients (one per line, optional)">
        <textarea
          rows={4}
          value={value.ingredients}
          onChange={(e) => onChange({ ...value, ingredients: e.target.value })}
          placeholder={"Masa harina\nPork shoulder\nCorn husks"}
          className={cn(inputClass, "resize-none")}
        />
      </Field>
    </>
  )
}

/** Each ingredient once, ignoring case and spacing ("Onions" in two dinners is one line). */
export function uniqueIngredients(ingredients: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ingredients) {
    const label = raw.trim()
    const key = label.toLowerCase()
    if (!label || seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

/** Adds ingredients to the grocery list (making one if needed), skipping any already on it. Returns how many were added. */
export function useSendToGroceries() {
  const { lists, addItem } = useStore()
  return async (ingredients: string[]): Promise<number> => {
    let list = lists.find((l) => /grocer|shopping/i.test(l.title))
    if (!list) list = await api.createList({ title: "Groceries", color: "green" })
    const open = new Set(list.items.filter((i) => !i.done).map((i) => i.label.trim().toLowerCase()))
    const toAdd = uniqueIngredients(ingredients).filter((i) => !open.has(i.toLowerCase()))
    const known = lists.some((l) => l.id === list!.id)
    for (const label of toAdd) {
      if (known) addItem(list.id, label)
      else await api.addListItem(list.id, label)
    }
    return toAdd.length
  }
}

/** "Add this week's ingredients to Groceries": every weekly meal's ingredients, each once. */
export function WeekGroceries() {
  const { meals } = useStore()
  const send = useSendToGroceries()
  const ingredients = uniqueIngredients(meals.filter((m) => !m.date).flatMap((m) => m.ingredients ?? []))
  // The result note belongs to the ingredients it was for; editing the menu brings the button back.
  const key = ingredients.join("\n").toLowerCase()
  const [sent, setSent] = useState<{ key: string; text: string } | null>(null)
  if (ingredients.length === 0) return null
  const note = sent?.key === key ? sent.text : null

  return (
    <button
      type="button"
      onClick={() => {
        void send(ingredients).then((n) =>
          setSent({ key, text: n === 0 ? "Everything's already on Groceries" : `Added ${n} to Groceries` }),
        )
      }}
      className="mt-3 flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold"
    >
      <ShoppingBasket className="size-3.5" />
      {note ?? `Add this week's ${ingredients.length} ingredients to Groceries`}
    </button>
  )
}

/** Upcoming one-date menus, grouped by day, each with "Add to Groceries". */
export function SpecialDays({ onOpen }: { onOpen: (m: Meal) => void }) {
  const { meals, getMember } = useStore()
  const send = useSendToGroceries()
  const [sent, setSent] = useState<Record<string, string>>({})
  const today = toISODate(new Date())
  const dated = meals.filter((m) => m.date && m.date >= today).sort((a, b) => (a.date! < b.date! ? -1 : 1))
  if (dated.length === 0) return null
  const dates = [...new Set(dated.map((m) => m.date!))]

  return (
    <section className="space-y-3">
      <p className="os-label flex items-center gap-1.5 px-1">
        <CalendarHeart className="size-3.5 text-season" /> Special days
      </p>
      {dates.map((date) => {
        const items = dated.filter((m) => m.date === date)
        const ingredients = items.flatMap((m) => m.ingredients ?? [])
        return (
          <div key={date} className="space-y-2 rounded-lg bg-card p-3">
            <p className="text-sm font-bold">{date === today ? "Today" : longDate(date)}</p>
            {items.map((m) => (
              <button key={m.id} type="button" onClick={() => onOpen(m)} className="flex w-full items-baseline gap-2 text-left">
                <span className="w-20 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{m.type}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{m.name}</span>
                {m.memberId ? <span className="text-xs text-muted-foreground">{getMember(m.memberId).name}</span> : null}
              </button>
            ))}
            {ingredients.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  void send(ingredients).then((n) =>
                    setSent((s) => ({ ...s, [date]: n === 0 ? "Already on Groceries" : `Added ${n} to Groceries` })),
                  )
                }}
                className="flex items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold"
              >
                <ShoppingBasket className="size-3.5" />
                {sent[date] ?? `Add ${ingredients.length} ingredients to Groceries`}
              </button>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}
