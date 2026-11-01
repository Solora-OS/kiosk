"use client"

import { useEffect, useState } from "react"
import { Check, Plus, Repeat, Star, Sun } from "lucide-react"
import { type Chore, type SummerMode, choreDone, choreDueOn, choreSchedule, memberBg, memberSoft, pausesWhileAway, toISODate } from "@/lib/data"
import { useSummer } from "@/lib/summer"
import { homeTodayISO, useHomeTimeZone } from "@/lib/home-time"
import { CHORE_ICONS, choreIcon, suggestChoreIcon } from "@/lib/chore-icons"
import { isAwayOn, useAway } from "@/lib/away"
import { AwayBanner } from "@/components/ui/reusables/away-banner"
import { Switch } from "@/components/os/controls"
import { cn } from "@/lib/utils"
import { celebrateCompletion } from "@/lib/celebration"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { ActionRow } from "@/components/ui/reusables/action-row"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { useHighlight, useStore } from "@/lib/store"

const dueOptions = ["Today", "Tomorrow", "Sat", "Sun", "This week"]

type RepeatPreset = "never" | "daily" | "weekdays" | "weekends" | "custom"
const repeatPresets: { value: RepeatPreset; label: string; days: number[] }[] = [
  { value: "never", label: "Never", days: [] },
  { value: "daily", label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
  { value: "weekdays", label: "Weekdays", days: [1, 2, 3, 4, 5] },
  { value: "weekends", label: "Weekends", days: [0, 6] },
  { value: "custom", label: "Pick days", days: [] },
]
// Monday-first, matching the calendar's week strip.
const weekdayPicker = [
  { day: 1, label: "M" }, { day: 2, label: "T" }, { day: 3, label: "W" }, { day: 4, label: "T" },
  { day: 5, label: "F" }, { day: 6, label: "S" }, { day: 0, label: "S" },
]

function presetFor(days: number[] | undefined): RepeatPreset {
  if (!days?.length) return "never"
  const key = [...days].sort().join(",")
  return repeatPresets.find((p) => p.value !== "custom" && p.days.length && [...p.days].sort().join(",") === key)?.value ?? "custom"
}

const homeDate = () => new Date(`${homeTodayISO()}T00:00:00`)

/**
 * Today's date at home, checked each minute and whenever the app comes back to
 * the foreground. Chores reset at home midnight, wherever the phone is.
 */
function useToday(): Date {
  const zone = useHomeTimeZone()
  const [today, setToday] = useState(homeDate)
  useEffect(() => {
    const refresh = () => setToday((prev) => (toISODate(prev) === homeTodayISO() ? prev : homeDate()))
    refresh()
    const timer = setInterval(refresh, 60_000)
    document.addEventListener("visibilitychange", refresh)
    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", refresh)
    }
  }, [zone])
  return today
}

type FormState = {
  title: string; memberId: string; points: number; due: string; repeat: RepeatPreset; days: number[]
  icon: string | null
  /** Set once someone picks a picture, so typing the name stops suggesting one. */
  iconPicked: boolean
  keepWhileAway: boolean
  summerMode: SummerMode
  summerDays: number[]
}
const emptyForm: FormState = {
  title: "", memberId: "", points: 10, due: "Today", repeat: "never", days: [], icon: null, iconPicked: false, keepWhileAway: false,
  summerMode: "same", summerDays: [],
}

const summerChoices: { value: SummerMode; label: string }[] = [
  { value: "same", label: "Same days" },
  { value: "days", label: "Different days" },
  { value: "off", label: "Not in summer" },
  { value: "only", label: "Only in summer" },
]

/** "Feed Bruno", "Feed Bruno and Water plants", "Feed Bruno, Water plants and 2 more". */
function titleList(titles: string[]): string {
  if (titles.length <= 2) return titles.join(" and ")
  return `${titles.slice(0, 2).join(", ")} and ${titles.length - 2} more`
}

export function ChoresView() {
  const { chores, members, getMember, activeMember, currentMember, can, addChore, updateChore, deleteChore, toggleChore } = useStore()
  const canManage = can("chores")
  const { highlight, register, clearHighlight, refs } = useHighlight("chores")
  const today = useToday()
  const todayISO = toISODate(today)

  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<Chore | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const visible = chores.filter((c) => (activeMember ? c.memberId === activeMember : true))
  // While the family is away, repeating chores pause (one-off chores still show).
  const away = useAway()
  const paused = isAwayOn(away, todayISO)
  // During the summer break each chore follows its summer rule.
  const summer = useSummer()
  const inSummer = !!summer && todayISO >= summer.from && todayISO <= summer.until
  const isDue = (c: Chore) => choreDueOn(c, today, summer) && !(paused && pausesWhileAway(c))
  // Chores that don't stop for a trip: the dog still eats.
  const keptTitles = chores.filter((c) => c.repeatDays?.length && c.keepWhileAway).map((c) => c.title)
  const except = keptTitles.length ? `, except ${titleList(keptTitles)}` : ""
  const dueToday = visible.filter(isDue)
  const otherDays = visible.filter((c) => !isDue(c))
  const earned = dueToday.filter((c) => choreDone(c, todayISO)).reduce((s, c) => s + c.points, 0)
  const total = dueToday.reduce((s, c) => s + c.points, 0)
  const pct = total ? Math.round((earned / total) * 100) : 0

  useEffect(() => {
    if (!highlight) return
    const el = refs.get(highlight.id)
    if (!el) return
    el.scrollIntoView({ behavior: "smooth", block: "center" })
    el.classList.add("highlight-flash")
    const t = setTimeout(() => {
      el.classList.remove("highlight-flash")
      clearHighlight()
    }, 2000)
    return () => clearTimeout(t)
  }, [highlight, refs, clearHighlight])

  const openAdd = () => {
    if (!canManage) return
    setEditing(null)
    setForm({ ...emptyForm, memberId: activeMember ?? members[0]?.id ?? "" })
    setSheetOpen(true)
  }

  const openEdit = (c: Chore) => {
    if (!canManage) return
    setEditing(c)
    setForm({
      title: c.title,
      memberId: c.memberId,
      points: c.points,
      due: c.due || "Today",
      repeat: presetFor(c.repeatDays),
      days: c.repeatDays ?? [],
      icon: c.icon ?? null,
      iconPicked: true,
      keepWhileAway: c.keepWhileAway ?? false,
      summerMode: c.summerMode ?? "same",
      summerDays: c.summerDays ?? [],
    })
    setSheetOpen(true)
  }

  const setRepeat = (repeat: RepeatPreset) =>
    setForm((f) => ({
      ...f,
      repeat,
      // "Pick days" starts from whatever the previous preset selected, or today.
      days: repeat === "custom" ? (f.days.length ? f.days : [today.getDay()]) : repeatPresets.find((p) => p.value === repeat)!.days,
    }))

  const toggleDay = (day: number) =>
    setForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((d) => d !== day) : [...f.days, day] }))

  const save = () => {
    if (!form.title.trim()) return
    if (form.repeat !== "never" && form.days.length === 0) return
    // An empty list clears the repeat on the hub, turning the chore back into a one-off.
    const repeatDays = form.repeat === "never" ? [] : [...form.days].sort()
    const payload = {
      title: form.title.trim(), memberId: form.memberId, points: form.points, due: form.due, repeatDays, icon: form.icon,
      keepWhileAway: repeatDays.length > 0 && form.keepWhileAway,
      summerMode: repeatDays.length > 0 ? form.summerMode : "same",
      summerDays: repeatDays.length > 0 && form.summerMode === "days" ? [...form.summerDays].sort() : [],
    }
    if (editing) updateChore(editing.id, payload)
    else addChore({ ...payload, done: false })
    setSheetOpen(false)
  }

  const renderChore = (chore: Chore, offDay = false) => {
    const member = getMember(chore.memberId)
    const done = choreDone(chore, todayISO)
    // Only the person it's for, or someone who manages chores, can check it off.
    const canToggle = canManage || chore.memberId === currentMember?.id
    const picture = choreIcon(chore.icon ?? undefined)
    return (
      <div key={chore.id} ref={register(chore.id)} className={cn("rounded-md", offDay && "opacity-60")}>
        <ActionRow
          onEdit={canManage ? () => openEdit(chore) : undefined}
          onDelete={canManage ? () => setDeleteId(chore.id) : undefined}
        >
          {/* The whole row checks the chore off, not just the little box. */}
          <button
            type="button"
            disabled={!canToggle}
            title={canToggle ? undefined : `Only ${member.name} or a parent can check this off`}
            onClick={() => {
              toggleChore(chore.id)
              // Celebrate when this finishes everything due today.
              const othersDone = chores
                .filter((c) => isDue(c) && c.id !== chore.id)
                .filter((c) => canManage || c.memberId === chore.memberId)
                .every((c) => choreDone(c, todayISO))
              if (!done && !offDay && othersDone) {
                celebrateCompletion("strong")
              }
            }}
            aria-pressed={done}
            aria-label={
              !canToggle ? `${chore.title}, ${member.name}'s chore` : done ? `Mark ${chore.title} not done` : `Mark ${chore.title} done`
            }
            className="flex min-h-[4.5rem] w-full items-center gap-4 bg-card px-4 py-3 text-left transition-colors active:bg-secondary disabled:cursor-default"
          >
            <span
              aria-hidden
              className={cn(
                picture
                  ? cn(
                      // A picture tile kids can recognise; it fills with their color when done.
                      "relative flex size-14 shrink-0 items-center justify-center rounded-lg transition-colors",
                      done ? cn(memberBg[member.color], "text-white") : memberSoft[member.color],
                      !canToggle && !done && "opacity-50",
                    )
                  : cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      !canToggle && !done && "border-dashed opacity-50",
                      done ? cn(memberBg[member.color], "border-transparent text-white") : "border-border text-transparent",
                    ),
              )}
            >
              {picture ? (
                <>
                  <picture.Icon className="size-7" />
                  {done ? (
                    <span className="absolute -right-1 -bottom-1 flex size-5 items-center justify-center rounded-full bg-card text-foreground shadow">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </>
              ) : (
                <Check className="size-5" strokeWidth={3} />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn("block text-[1.05rem] font-medium leading-tight", done && "text-muted-foreground line-through")}>
                {chore.title}
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                {chore.repeatDays?.length ? <Repeat className="size-3" aria-label="Repeats" /> : null}
                {choreSchedule(chore)}
              </span>
            </span>
            <span
              className={cn(
                "flex items-center gap-1 text-sm font-semibold",
                done ? "text-muted-foreground" : "text-member-amber",
              )}
            >
              <Star className={cn("size-3.5", done ? "fill-muted-foreground" : "fill-member-amber")} />
              {chore.points}
            </span>
            <MemberAvatar member={member} size="sm" />
          </button>
        </ActionRow>
      </div>
    )
  }

  const deleting = deleteId ? chores.find((c) => c.id === deleteId) : null

  return (
    <div className="space-y-4 px-4 py-4">
      <AwayBanner note={paused ? `Repeating chores are paused${except}. Streaks won't break.` : `Repeating chores pause while you're away${except}.`} />
      {inSummer && summer ? (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Sun className="size-3.5 text-season" />
          Summer schedule until {new Date(`${summer.until}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" })}
        </p>
      ) : null}
      {/* Compact progress line */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">
          <span className="font-semibold text-foreground">{earned}</span> / {total} pts earned today
        </p>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-xs font-semibold text-muted-foreground">{pct}%</span>
        </div>
      </div>

      <div className="space-y-2">
        {dueToday.map((chore) => renderChore(chore))}

        {visible.length === 0 ? (
          <p className="py-10 text-center text-sm text-muted-foreground">No chores for this filter.</p>
        ) : dueToday.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing due today.</p>
        ) : null}
      </div>

      {otherDays.length > 0 ? (
        <div className="space-y-2">
          <p className="os-label px-1">Other days</p>
          {otherDays.map((chore) => renderChore(chore, true))}
        </div>
      ) : null}

      {canManage ? (
        <button
          type="button"
          onClick={openAdd}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border py-3 text-sm font-semibold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
        >
          <Plus className="size-4" />
          Assign chore
        </button>
      ) : null}

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={editing ? "Edit chore" : "Assign chore"}
        footer={
          <button
            type="button"
            onClick={save}
            className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            {editing ? "Save changes" : "Assign chore"}
          </button>
        }
      >
        <Field label="Chore">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => {
              const title = e.target.value
              setForm((f) => ({ ...f, title, icon: f.iconPicked ? f.icon : suggestChoreIcon(title) }))
            }}
            placeholder="Take out trash"
            className={inputClass}
          />
        </Field>
        <Field label="Picture">
          <div className="grid grid-cols-6 gap-1.5 sm:grid-cols-8">
            {CHORE_ICONS.map(({ key, label, Icon }) => {
              const on = form.icon === key
              return (
                <button
                  key={key}
                  type="button"
                  aria-label={label}
                  aria-pressed={on}
                  title={label}
                  onClick={() => setForm((f) => ({ ...f, icon: on ? null : key, iconPicked: true }))}
                  className={cn(
                    "flex aspect-square items-center justify-center rounded-md transition-colors",
                    on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  <Icon className="size-5" />
                </button>
              )
            })}
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {form.icon ? `${choreIcon(form.icon)?.label}: shown to kids who can't read yet.` : "Optional. Helps kids who can't read yet."}
          </p>
        </Field>
        <Field label="Assigned to">
          <select
            value={form.memberId}
            onChange={(e) => setForm((f) => ({ ...f, memberId: e.target.value }))}
            className={inputClass}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="flex gap-3">
          <Field label="Points">
            <select
              value={form.points}
              onChange={(e) => setForm((f) => ({ ...f, points: Number(e.target.value) }))}
              className={inputClass}
            >
              {[5, 10, 15, 20, 25].map((p) => (
                <option key={p} value={p}>
                  {p} pts
                </option>
              ))}
            </select>
          </Field>
          <Field label="Repeats">
            <select
              value={form.repeat}
              onChange={(e) => setRepeat(e.target.value as RepeatPreset)}
              className={inputClass}
            >
              {repeatPresets.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {form.repeat === "never" ? (
          <Field label="Due">
            <select
              value={form.due}
              onChange={(e) => setForm((f) => ({ ...f, due: e.target.value }))}
              className={inputClass}
            >
              {dueOptions.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        ) : form.repeat === "custom" ? (
          <Field label="On">
            <div className="flex gap-1.5">
              {weekdayPicker.map(({ day, label }) => {
                const on = form.days.includes(day)
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => toggleDay(day)}
                    aria-pressed={on}
                    aria-label={["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}
                    className={cn(
                      "size-9 rounded-full text-sm font-semibold transition-colors",
                      on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                    )}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </Field>
        ) : null}
        {form.repeat !== "never" ? (
          <div className="flex items-center justify-between gap-3 py-1">
            <span className="min-w-0">
              <span className="block text-sm font-medium">Keep going while away</span>
              <span className="block text-xs text-muted-foreground">For pets and plants. Away mode won't pause it.</span>
            </span>
            <Switch label="Keep going while away" on={form.keepWhileAway} onChange={(keepWhileAway) => setForm((f) => ({ ...f, keepWhileAway }))} />
          </div>
        ) : null}
        {form.repeat !== "never" ? (
          <Field label="In summer">
            <div className="grid grid-cols-2 gap-1.5">
              {summerChoices.map((c) => (
                <button key={c.value} type="button" aria-pressed={form.summerMode === c.value}
                  onClick={() => setForm((f) => ({ ...f, summerMode: c.value, summerDays: c.value === "days" && !f.summerDays.length ? f.days : f.summerDays }))}
                  className={cn(
                    "rounded-md py-2 text-sm font-medium transition-colors",
                    form.summerMode === c.value ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                  )}>
                  {c.label}
                </button>
              ))}
            </div>
            {form.summerMode === "days" ? (
              <div className="mt-2 flex gap-1.5">
                {weekdayPicker.map(({ day, label }) => {
                  const on = form.summerDays.includes(day)
                  return (
                    <button key={day} type="button" aria-pressed={on}
                      aria-label={`In summer: ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][day]}`}
                      onClick={() => setForm((f) => ({ ...f, summerDays: on ? f.summerDays.filter((d) => d !== day) : [...f.summerDays, day] }))}
                      className={cn("size-9 rounded-full text-sm font-semibold transition-colors", on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
                      {label}
                    </button>
                  )
                })}
              </div>
            ) : null}
            <span className="mt-1 block text-xs text-muted-foreground">
              {summer ? `This summer: ${new Date(`${summer.from}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(`${summer.until}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}.` : "A parent sets the summer break in Settings › Family."}
            </span>
          </Field>
        ) : null}
      </BottomSheet>

      <ConfirmDialog
        open={!!deleteId}
        title="Delete chore?"
        message={deleting ? `“${deleting.title}” will be removed.` : ""}
        onCancel={() => setDeleteId(null)}
        onConfirm={() => {
          if (deleteId) deleteChore(deleteId)
          setDeleteId(null)
        }}
      />
    </div>
  )
}
