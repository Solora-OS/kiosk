"use client"

import { useEffect, useState } from "react"
import { Check, Repeat, Star, Sun, Users } from "lucide-react"
import { type Chore, type Member, type SummerMode, choreDone, choreDueOn, choreSchedule, memberBg, memberSoft, pausesWhileAway, toISODate } from "@/lib/data"
import { useSummer } from "@/lib/summer"
import { homeTodayISO, useHomeTimeZone } from "@/lib/home-time"
import { CHORE_ICONS, choreIcon, suggestChoreIcon } from "@/lib/chore-icons"
import { isAwayOn, useAway } from "@/lib/away"
import { AwayBanner } from "@/components/ui/reusables/away-banner"
import { Switch } from "@/components/os/controls"
import { cn } from "@/lib/utils"
import { celebrateCompletion } from "@/lib/celebration"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { BottomSheet, ChoiceChips, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { MoreMenu, editDelete } from "@/components/ui/reusables/more-menu"
import { HeaderSlot } from "@/components/ui/reusables/header-slot"
import { HeaderAdd } from "@/components/ui/reusables/header-add"
import { RewardsShelf } from "./rewards-shelf"
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
  const { chores, members, getMember, activeMember, currentMember, can, addChore, updateChore, deleteChore, toggleChore, tab, setTab } = useStore()
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
    const Pic = choreIcon(chore.icon ?? undefined)?.Icon ?? Check
    return (
      <div
        key={chore.id}
        ref={register(chore.id)}
        className={cn("flex items-center gap-1 border-t border-hairline pr-1.5", offDay && "opacity-60")}
      >
        {/* The whole row checks the chore off. The picture fills with the person's color when it's done. */}
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
            if (!done && !offDay && othersDone) celebrateCompletion("strong")
          }}
          aria-pressed={done}
          aria-label={!canToggle ? `${chore.title}, ${member.name}'s chore` : done ? `Mark ${chore.title} not done` : `Mark ${chore.title} done`}
          className="flex min-h-[4.5rem] min-w-0 flex-1 items-center gap-3 py-2.5 pl-3 text-left active:bg-secondary disabled:cursor-default"
        >
          <span
            aria-hidden
            className={cn(
              "relative flex size-[3.25rem] shrink-0 items-center justify-center rounded-2xl transition-colors",
              done ? cn(memberBg[member.color], "text-white") : memberSoft[member.color],
              !canToggle && !done && "opacity-50",
            )}
          >
            <Pic className="size-6" />
            {done ? (
              <span className="check-pop absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full bg-card text-foreground shadow-[0_0_0_1px_var(--hairline)]">
                <Check className="size-3" strokeWidth={3} />
              </span>
            ) : null}
          </span>
          <span className="min-w-0 flex-1">
            <span className={cn("block text-[1rem] font-medium leading-tight", done && "text-muted-foreground line-through")}>{chore.title}</span>
            <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
              {chore.repeatDays?.length ? <Repeat className="size-3" aria-label="Repeats" /> : null}
              {choreSchedule(chore)}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-sm font-semibold text-muted-foreground tabular">
            <Star className={cn("size-3.5", done ? "fill-muted-foreground" : "fill-member-amber text-member-amber")} />
            {chore.points}
          </span>
        </button>
        {canManage ? <MoreMenu label={`${chore.title} options`} items={editDelete(() => openEdit(chore), () => setDeleteId(chore.id))} /> : null}
      </div>
    )
  }

  // One lane per person with something due, plus "Anyone" for chores nobody's assigned.
  const lanes = [
    ...members
      .filter((m) => m.id !== "family" && dueToday.some((c) => c.memberId === m.id))
      .map((m) => ({ key: m.id, member: m as Member | null, chores: dueToday.filter((c) => c.memberId === m.id) })),
  ]
  const unassigned = dueToday.filter((c) => !members.some((m) => m.id === c.memberId && m.id !== "family"))
  if (unassigned.length) lanes.push({ key: "anyone", member: null, chores: unassigned })

  const deleting = deleteId ? chores.find((c) => c.id === deleteId) : null

  const segment = (
    <HeaderSlot name="extras">
      <div className="flex h-12 items-center gap-0.5 rounded-full bg-secondary p-1">
        {(["chores", "rewards"] as const).map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              "h-10 rounded-full px-5 text-sm font-medium transition-colors",
              tab === t ? "bg-card text-foreground shadow-[0_0_0_1px_var(--hairline)]" : "text-muted-foreground",
            )}
          >
            {t === "chores" ? "Today" : "Rewards"}
          </button>
        ))}
      </div>
    </HeaderSlot>
  )

  // Rewards is a view of Chores, as on the phone.
  if (tab === "rewards") {
    return (
      <>
        {segment}
        <RewardsShelf />
      </>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      {segment}
      {canManage ? <HeaderAdd label="Assign chore" onClick={openAdd} /> : null}
      <AwayBanner note={paused ? `Repeating chores are paused${except}. Streaks won't break.` : `Repeating chores pause while you're away${except}.`} />
      <div className="flex items-center justify-between gap-4">
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {inSummer && summer ? (
            <>
              <Sun className="size-4" />
              Summer schedule until {new Date(`${summer.until}T00:00:00`).toLocaleDateString(undefined, { month: "long", day: "numeric" })}
            </>
          ) : (
            "Tap a picture when it's done."
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          <span className="font-semibold text-foreground tabular">{earned}</span> of {total} points earned today
        </p>
      </div>

      {dueToday.length === 0 ? (
        <p className="os-card px-5 py-8 text-center text-muted-foreground">
          {visible.length === 0 ? "No chores for this filter." : "Nothing due today."}
        </p>
      ) : (
        <div className="grid items-start gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(Math.max(lanes.length, 1), 4)}, minmax(0, 1fr))` }}>
          {lanes.map(({ key, member, chores: mine }) => {
            const done = mine.filter((c) => choreDone(c, todayISO)).length
            const pts = mine.reduce((n, c) => n + c.points, 0)
            return (
              <section key={key} className="os-card overflow-hidden">
                <div className="flex items-center gap-3 px-4 pb-3 pt-4">
                  {member ? (
                    <MemberAvatar member={member} size="lg" />
                  ) : (
                    <span className="flex size-12 items-center justify-center rounded-full bg-secondary text-muted-foreground">
                      <Users className="size-5" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[1.1rem] font-medium">{member ? member.name : "Anyone"}</span>
                    <span className="font-mono text-[0.72rem] text-muted-foreground tabular">
                      {done} of {mine.length} · {pts} pts
                    </span>
                  </span>
                </div>
                <div className="mx-4 mb-3 h-1.5 overflow-hidden rounded-full bg-secondary" aria-hidden>
                  <div
                    className={cn("h-full rounded-full transition-[width] duration-300", member ? memberBg[member.color] : "bg-foreground")}
                    style={{ width: `${mine.length ? (done / mine.length) * 100 : 0}%` }}
                  />
                </div>
                {mine.map((c) => renderChore(c))}
              </section>
            )
          })}
        </div>
      )}

      {otherDays.length > 0 ? (
        <section className="space-y-2.5">
          <p className="os-label px-1">Other days</p>
          <div className="os-card grid grid-cols-2 overflow-hidden [&>*:nth-child(-n+2)]:border-t-0">{otherDays.map((chore) => renderChore(chore, true))}</div>
        </section>
      ) : null}

      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={editing ? "Edit chore" : "Assign chore"}
        footer={
          <button
            type="button"
            onClick={save}
            className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
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
                    "flex aspect-square items-center justify-center rounded-[12px] transition-colors",
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
        <div>
          <span className="os-label mb-2 block">For</span>
          <ChoiceChips
            value={form.memberId}
            onChange={(memberId) => setForm((f) => ({ ...f, memberId }))}
            options={members.map((m) => ({ value: m.id, label: m.name, lead: <MemberAvatar member={m} size="sm" /> }))}
          />
        </div>
        <div className="space-y-5">
          <div>
            <span className="os-label mb-2 block">Points</span>
            <ChoiceChips
              value={form.points}
              onChange={(points) => setForm((f) => ({ ...f, points }))}
              options={[5, 10, 15, 20, 25].map((p) => ({ value: p, label: `${p}` }))}
            />
          </div>
          <div>
            <span className="os-label mb-2 block">Repeats</span>
            <ChoiceChips value={form.repeat} onChange={setRepeat} options={repeatPresets.map((p) => ({ value: p.value, label: p.label }))} />
          </div>
        </div>
        {form.repeat === "never" ? (
          <div>
            <span className="os-label mb-2 block">Due</span>
            <ChoiceChips value={form.due} onChange={(due) => setForm((f) => ({ ...f, due }))} options={dueOptions.map((d) => ({ value: d, label: d }))} />
          </div>
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
                      "size-11 rounded-full text-sm font-semibold transition-colors",
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
                    "h-11 rounded-full text-sm font-medium transition-colors",
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
                      className={cn("size-11 rounded-full text-sm font-semibold transition-colors", on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground")}>
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
