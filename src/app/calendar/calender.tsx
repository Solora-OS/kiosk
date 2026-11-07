"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronDown, ChevronLeft, ChevronRight, MapPin, Repeat, Settings2, Trash2, Check, Pencil, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type CalendarEvent,
  type Calendar,
  type Member,
  type MemberColor,
  expandEventsOn,
  eventRangeLabel,
  defaultReminder,
  reminderOptions,
  eventRepeatLabel,
  eventTimeLabel,
  formatClock,
  memberBg,
  occurrenceOn,
  toISODate,
} from "@/lib/data"
import { Switch } from "@/components/os/controls"
import { MemberAvatar } from "@/components/ui/reusables/member-avatar"
import { BottomSheet, ChoiceChips, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { MoreMenu, editDelete } from "@/components/ui/reusables/more-menu"
import { HeaderSlot } from "@/components/ui/reusables/header-slot"
import { HeaderAdd } from "@/components/ui/reusables/header-add"
import { homeTodayISO } from "@/lib/home-time"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { RepeatPicker } from "@/components/ui/reusables/repeat-picker"
import { AwayBanner } from "@/components/ui/reusables/away-banner"
import { useHighlight, useStore } from "@/lib/store"

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const dayNamesShort = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const calendarColors: MemberColor[] = ["blue", "coral", "teal", "amber", "pink", "green"]


/** Every quarter hour of the day, as hours since midnight. */

/** The day after an ISO date. */
function nextDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + 1)
  return toISODate(d)
}

/** Whether an event fills the whole of `iso` (all-day, or a middle day of a multi-day event). */
function coversWholeDay(e: CalendarEvent, iso: string): boolean {
  const occ = occurrenceOn(e, iso)
  return !!e.allDay || (iso > occ.start && iso < occ.end)
}

/** The hours an event occupies on `iso`: overnight events run to midnight, then from midnight. */
function hoursOn(e: CalendarEvent, iso: string): { from: number; to: number } {
  const occ = occurrenceOn(e, iso)
  const from = iso > occ.start ? 0 : e.start
  const to = iso < occ.end ? 24 : e.end
  return { from, to: Math.max(to, from + 0.5) }
}

/** Compact start time for a month cell: "9a", "5:30p". */
function shortClock(hour: number): string {
  const mins = Math.round(hour * 60)
  const h = Math.floor(mins / 60) % 24
  const m = mins % 60
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "a" : "p"}`
}


type ViewMode = "day" | "week" | "month"

type FormState = {
  title: string
  start: number
  end: number
  allDay: boolean
  /** Last day of a multi-day event (a trip, a conference); null for one day or an overnight event. */
  endDate: string | null
  reminderMinutes: number | null
  repeatDays: number[]
  repeatUntil: string | null
  countdown: boolean
  memberIds: string[]
  calendarId: string
  location: string
}

// ---- helpers ----------------------------------------------------------------

function startOfMonth(year: number, month: number): Date {
  return new Date(year, month, 1)
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

/** Build a 6-row grid of dates for the month view (may include prev/next overflow). */
function buildMonthGrid(year: number, month: number): Date[] {
  const first = startOfMonth(year, month)
  const firstDow = first.getDay() // 0=Sun
  const total = 42 // 6 weeks × 7
  const grid: Date[] = []
  for (let i = 0; i < total; i++) {
    const d = new Date(year, month, 1 - firstDow + i)
    grid.push(d)
  }
  return grid
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}


export function CalendarView() {
  const {
    events,
    calendars,
    members,
    getMember,
    activeMember,
    can,
    addEvent,
    updateEvent,
    deleteEvent,
    addCalendar,
    updateCalendar,
    deleteCalendar,
  } = useStore()
  const { highlight, register, clearHighlight, refs } = useHighlight("calendar")

  const canManage = can("calendar")
  const todayISO = useHomeToday()
  const today = useMemo(() => new Date(`${todayISO}T00:00:00`), [todayISO])

  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    if (typeof window !== "undefined") {
      return (localStorage.getItem("calendarViewMode") as ViewMode) || "month"
    }
    return "month"
  })

  const [selectedDate, setSelectedDate] = useState(todayISO)
  const [calFilter, setCalFilter] = useState<string | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [editing, setEditing] = useState<CalendarEvent | null>(null)
  const [form, setForm] = useState<FormState>({
    title: "",
    start: 9,
    end: 10,
    allDay: false,
    endDate: null,
    reminderMinutes: defaultReminder(false),
    repeatDays: [],
    repeatUntil: null,
    countdown: false,
    memberIds: [],
    calendarId: "",
    location: "",
  })
  /** The event being deleted, and the start date of the occurrence it was deleted from. */
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; occurrence: string } | null>(null)
  // `shown` may be one occurrence of a repeating event; its date is the one "This one" removes.
  const requestDelete = (shown: CalendarEvent) => setDeleteTarget({ id: shown.id, occurrence: shown.date })
  const [manageOpen, setManageOpen] = useState(false)
  const [confirmDeleteCal, setConfirmDeleteCal] = useState<Calendar | null>(null)

  const selDateObj = useMemo(() => new Date(`${selectedDate}T00:00:00`), [selectedDate])
  const [viewYear, setViewYear] = useState(selDateObj.getFullYear())
  const [viewMonth, setViewMonth] = useState(selDateObj.getMonth())

  // Keep viewYear/viewMonth in sync when selectedDate changes externally
  useEffect(() => {
    const d = new Date(`${selectedDate}T00:00:00`)
    setViewYear(d.getFullYear())
    setViewMonth(d.getMonth())
  }, [selectedDate])

  const filteredEvents = useMemo(
    () =>
      events
        .filter((e) => (activeMember ? e.memberIds.includes(activeMember) : true))
        .filter((e) => (calFilter ? e.calendarId === calFilter : true)),
    [events, activeMember, calFilter],
  )

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

  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  const openAdd = (date?: string) => {
    if (!canManage) return
    setEditing(null)
    setForm({
      title: "",
      start: 9,
      end: 10,
      allDay: false,
      endDate: null,
      reminderMinutes: defaultReminder(false),
      repeatDays: [],
      repeatUntil: null,
      countdown: false,
      memberIds: activeMember ? [activeMember] : [],
      calendarId: calFilter ?? calendars[0]?.id ?? "",
      location: "",
    })
    if (date) setSelectedDate(date)
    setSheetOpen(true)
  }

  const openEdit = (shown: CalendarEvent) => {
    if (!canManage) return
    // Edits apply to the whole series, so work from the stored event rather than one occurrence.
    const e = events.find((x) => x.id === shown.id) ?? shown
    setEditing(e)
    setForm({
      title: e.title,
      // Snap imported minute-level times onto the quarter-hour picker; a midnight end (24) is 12:00 AM.
      start: e.allDay ? 9 : (Math.round(e.start * 4) / 4) % 24,
      end: e.allDay ? 10 : (Math.round(e.end * 4) / 4) % 24,
      allDay: !!e.allDay,
      reminderMinutes: e.reminderMinutes ?? null,
      // A plain overnight event's next-day end is implied by its times; only a longer span is a set end date.
      endDate: e.endDate && (e.allDay || e.endDate !== nextDay(e.date) || e.end > e.start) ? e.endDate : null,
      repeatDays: e.repeatDays ?? [],
      repeatUntil: e.repeatUntil ?? null,
      countdown: !!e.countdown,
      memberIds: e.memberIds,
      calendarId: e.calendarId,
      location: e.location ?? "",
    })
    setSheetOpen(true)
  }

  const toggleFormMember = (id: string) =>
    setForm((f) => ({
      ...f,
      memberIds: f.memberIds.includes(id) ? f.memberIds.filter((m) => m !== id) : [...f.memberIds, id],
    }))

  const save = () => {
    if (!form.title.trim() || !form.calendarId) return
    // Editing keeps the event's own start day (it may be showing on a later day of an overnight event).
    const date = editing ? editing.date : selectedDate
    const payload = {
      title: form.title.trim(),
      date,
      time: form.allDay ? "" : formatClock(form.start),
      start: form.allDay ? 0 : form.start,
      end: form.allDay ? 24 : form.end,
      allDay: form.allDay,
      // A later end date makes one event of a trip or conference. Without one, a timed
      // event that ends at or before its start runs past midnight.
      endDate: form.endDate && form.endDate > date ? form.endDate
        : !form.allDay && form.end <= form.start ? nextDay(date) : null,
      // An empty list clears the repeat on the hub.
      repeatDays: [...form.repeatDays].sort(),
      repeatUntil: form.repeatDays.length ? form.repeatUntil : null,
      countdown: form.countdown,
      reminderMinutes: form.reminderMinutes,
      memberIds: form.memberIds,
      calendarId: form.calendarId,
      location: form.location.trim() || undefined,
    }
    if (editing) updateEvent(editing.id, payload)
    else addEvent(payload)
    setSheetOpen(false)
  }

  const deleting = deleteTarget ? events.find((e) => e.id === deleteTarget.id) : null
  const deletingSeries = !!deleting?.repeatDays?.length
  // The weekday a new event (or the series being edited) starts on, for the "Every Tuesday" preset.
  const formDate = editing ? editing.date : selectedDate
  const formWeekday = new Date(`${formDate}T00:00:00`).getDay()

  // ---- navigation -----------------------------------------------------------

  const navigatePrev = () => {
    if (viewMode === "day") {
      setSelectedDate(toISODate(addDays(selDateObj, -1)))
    } else if (viewMode === "week") {
      setSelectedDate(toISODate(addDays(selDateObj, -7)))
    } else {
      const d = new Date(viewYear, viewMonth - 1, 1)
      setViewYear(d.getFullYear())
      setViewMonth(d.getMonth())
    }
  }

  const navigateNext = () => {
    if (viewMode === "day") {
      setSelectedDate(toISODate(addDays(selDateObj, 1)))
    } else if (viewMode === "week") {
      setSelectedDate(toISODate(addDays(selDateObj, 7)))
    } else {
      const d = new Date(viewYear, viewMonth + 1, 1)
      setViewYear(d.getFullYear())
      setViewMonth(d.getMonth())
    }
  }

  const goToday = () => {
    setSelectedDate(todayISO)
    setViewYear(today.getFullYear())
    setViewMonth(today.getMonth())
  }

  const switchView = (v: ViewMode) => {
    setViewMode(v)
    localStorage.setItem("calendarViewMode", v)
  }

  // ---- period label ---------------------------------------------------------

  const periodLabel = useMemo(() => {
    if (viewMode === "day") {
      if (selectedDate === todayISO) return "Today"
      return selDateObj.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
    }
    if (viewMode === "week") {
      // The week is the seven days from the one you're on (today, by default), not Sunday to Saturday.
      const ws = selDateObj
      const we = addDays(ws, 6)
      const short = (d: Date) => monthNames[d.getMonth()].slice(0, 3)
      return ws.getMonth() === we.getMonth()
        ? `${short(ws)} ${ws.getDate()} – ${we.getDate()}`
        : `${short(ws)} ${ws.getDate()} – ${short(we)} ${we.getDate()}`
    }
    return monthNames[viewMonth]
  }, [viewMode, selDateObj, viewMonth, selectedDate, todayISO])

  // ---- event helpers --------------------------------------------------------

  const eventsForDate = (iso: string) =>
    expandEventsOn(filteredEvents, iso)

  const shownCal = calFilter ? calendars.find((c) => c.id === calFilter) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The period is the page title, with its arrows beside it, so there's one headline, not two. */}
      <HeaderSlot name="title">
        <h1 className="truncate font-display text-[2.85rem] leading-none">{periodLabel}</h1>
        {viewMode === "month" && viewYear !== today.getFullYear() ? (
          <span className="mb-1 font-display text-2xl text-muted-foreground tabular">{viewYear}</span>
        ) : null}
        <div className="mb-0.5 flex shrink-0 items-center rounded-full border border-hairline bg-card p-0.5">
          <button type="button" onClick={navigatePrev} aria-label="Previous" className="flex size-10 items-center justify-center rounded-full text-muted-foreground">
            <ChevronLeft className="size-4" />
          </button>
          <button type="button" onClick={goToday} className="h-10 rounded-full px-3 text-sm font-medium">
            Today
          </button>
          <button type="button" onClick={navigateNext} aria-label="Next" className="flex size-10 items-center justify-center rounded-full text-muted-foreground">
            <ChevronRight className="size-4" />
          </button>
        </div>
      </HeaderSlot>

      <HeaderSlot name="extras">
        {calendars.length > 1 || canManage ? (
          <CalendarsButton
            calendars={calendars}
            value={calFilter}
            onChange={setCalFilter}
            onManage={canManage ? () => setManageOpen(true) : undefined}
            label={shownCal ? shownCal.name : "All calendars"}
            color={shownCal?.color}
          />
        ) : null}
        <div className="flex h-12 items-center gap-0.5 rounded-full bg-secondary p-1">
          {(["day", "week", "month"] as ViewMode[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={viewMode === v}
              onClick={() => switchView(v)}
              className={cn(
                "h-10 rounded-full px-4 text-sm font-medium capitalize transition-colors",
                viewMode === v ? "bg-card text-foreground shadow-[0_0_0_1px_var(--hairline)]" : "text-muted-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
      </HeaderSlot>

      {canManage && calendars.length > 0 ? <HeaderAdd label="Add event" onClick={() => openAdd(selectedDate)} /> : null}

      <div className="px-8 pt-4 empty:hidden">
        <AwayBanner />
      </div>

      {/* ---- views ---------------------------------------------------------- */}
      <div className="page-in flex min-h-0 flex-1 flex-col overflow-y-auto" key={viewMode}>
        {viewMode === "month" ? (
          <MonthView
            year={viewYear}
            month={viewMonth}
            todayISO={todayISO}
            selectedDate={selectedDate}
            events={filteredEvents}
            calendars={calendars}
            onSelectDate={(iso) => {
              setSelectedDate(iso)
              switchView("day")
            }}
            onAddEvent={canManage ? (iso) => openAdd(iso) : undefined}
          />
        ) : viewMode === "week" ? (
          <WeekView
            anchorDate={selDateObj}
            todayISO={todayISO}
            selectedDate={selectedDate}
            events={filteredEvents}
            calendars={calendars}
            register={register}
            onSelectDate={(iso) => {
              setSelectedDate(iso)
              switchView("day")
            }}
            onEdit={canManage ? openEdit : undefined}
          />
        ) : (
          <DayView
            selectedDate={selectedDate}
            events={eventsForDate(selectedDate)}
            calendars={calendars}
            getMember={getMember}
            register={register}
            canManage={canManage}
            onEdit={openEdit}
            onDelete={requestDelete}
          />
        )}
      </div>

      {/* Add / edit event sheet */}
      <BottomSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title={editing ? "Edit event" : "New event"}
        footer={
          <button
            type="button"
            onClick={save}
            className="os-button w-full"
          >
            {editing ? "Save changes" : "Add event"}
          </button>
        }
      >
        <Field label="Title">
          <input
            autoFocus
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Soccer practice"
            className={inputClass}
          />
        </Field>
        <div>
          <span className="os-label mb-2 block">Calendar</span>
          <ChoiceChips
            value={form.calendarId}
            onChange={(calendarId) => setForm((f) => ({ ...f, calendarId }))}
            options={calendars.map((c) => ({
              value: c.id,
              label: c.name,
              lead: <span className={cn("ml-2.5 size-2.5 rounded-full", memberBg[c.color])} aria-hidden />,
            }))}
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="text-sm font-medium">All day</span>
          <Switch label="All day" on={form.allDay} onChange={(allDay) => setForm((f) => ({
            ...f,
            allDay,
            // Keep the reminder if it means something for the new kind of event.
            reminderMinutes: reminderOptions(allDay).some((o) => o.value === f.reminderMinutes) ? f.reminderMinutes : defaultReminder(allDay),
          }))} />
        </div>
        {form.allDay ? (
          <Field label="Through">
            <input
              type="date"
              value={form.endDate ?? formDate}
              min={formDate}
              onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value > formDate ? e.target.value : null }))}
              className={inputClass}
            />
          </Field>
        ) : (
          <>
            {/* Steppers, not dropdowns: a wall has no popup pickers worth using. */}
            <div className="grid grid-cols-2 gap-3">
              <TimeStepper
                label="Starts"
                value={form.start}
                onChange={(start) =>
                  // Keep the event's length when the start moves.
                  setForm((f) => {
                    const length = (f.end - f.start + 24) % 24 || 1
                    return { ...f, start, end: (start + length) % 24 }
                  })
                }
              />
              <TimeStepper label="Ends" value={form.end} onChange={(end) => setForm((f) => ({ ...f, end }))} />
            </div>
            <Field label="Ends on">
              <input
                type="date"
                value={form.endDate ?? (form.end <= form.start ? nextDay(formDate) : formDate)}
                min={formDate}
                onChange={(e) => setForm((f) => ({ ...f, endDate: e.target.value > formDate ? e.target.value : null }))}
                className={inputClass}
              />
            </Field>
            {!form.endDate && form.end <= form.start ? (
              <p className="-mt-1 text-xs text-muted-foreground">Ends the next day at {formatClock(form.end)}.</p>
            ) : null}
          </>
        )}
        <RepeatPicker
          days={form.repeatDays}
          until={form.repeatUntil}
          anchorDay={formWeekday}
          minUntil={formDate}
          onChange={({ days, until }) => setForm((f) => ({ ...f, repeatDays: days, repeatUntil: until }))}
        />
        <div>
          <span className="os-label mb-2 block">Remind</span>
          <ChoiceChips
            value={form.reminderMinutes ?? -1}
            onChange={(v) => setForm((f) => ({ ...f, reminderMinutes: v === -1 ? null : v }))}
            options={reminderOptions(form.allDay).map((o) => ({ value: o.value ?? -1, label: o.label }))}
          />
          <span className="mt-2 block text-xs text-muted-foreground">
            {form.memberIds.length ? "Sent to the people assigned." : "Sent to everyone in the family."}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3 py-1">
          <span>
            <span className="block text-sm font-medium">Count down to this</span>
            <span className="block text-xs text-muted-foreground">Shows &ldquo;9 sleeps until…&rdquo; at the top of the calendar</span>
          </span>
          <Switch label="Count down to this" on={form.countdown} onChange={(countdown) => setForm((f) => ({ ...f, countdown }))} />
        </div>
        <div>
          <span className="os-label mb-2 block">Who</span>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const on = form.memberIds.includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleFormMember(m.id)}
                  className={cn(
                    "flex h-11 items-center gap-2 rounded-full border pl-1.5 pr-4 text-[0.95rem] font-medium transition-colors",
                    on ? "border-transparent bg-foreground text-background" : "border-hairline bg-card text-foreground",
                  )}
                >
                  <MemberAvatar member={m} size="sm" />
                  {m.name}
                </button>
              )
            })}
            {members.length === 0 ? (
              <span className="text-xs text-muted-foreground">Add family members first.</span>
            ) : null}
          </div>
        </div>
        <Field label="Location (optional)">
          <input
            value={form.location}
            onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            placeholder="Field 3"
            className={inputClass}
          />
        </Field>
      </BottomSheet>

      {/* Manage calendars */}
      <ManageCalendarsSheet
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        calendars={calendars}
        members={members}
        onAdd={addCalendar}
        onUpdate={updateCalendar}
        onDelete={(id) => {
          if (calFilter === id) setCalFilter(null)
          deleteCalendar(id)
        }}
        confirmDelete={confirmDeleteCal}
        setConfirmDelete={setConfirmDeleteCal}
      />

      {/* Event delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title={deletingSeries ? "Delete repeating event?" : "Delete event?"}
        message={
          !deleting ? ""
          : deletingSeries ? `Remove just this "${deleting.title}", or every one in the series?`
          : `"${deleting.title}" will be removed.`
        }
        confirmLabel={deletingSeries ? "All events" : "Delete"}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteEvent(deleteTarget.id)
          setDeleteTarget(null)
        }}
        secondaryLabel="This one"
        onSecondary={
          deletingSeries && deleting && deleteTarget
            ? () => {
                updateEvent(deleting.id, { skipDates: [...(deleting.skipDates ?? []), deleteTarget.occurrence] })
                setDeleteTarget(null)
              }
            : undefined
        }
      />

      {/* Calendar delete confirmation — rendered outside ManageCalendarsSheet to avoid nested portal conflict */}
      <ConfirmDialog
        open={!!confirmDeleteCal}
        title="Delete calendar?"
        message={confirmDeleteCal ? `"${confirmDeleteCal.name}" and all its events will be removed.` : ""}
        onCancel={() => setConfirmDeleteCal(null)}
        onConfirm={() => {
          if (confirmDeleteCal) {
            if (calFilter === confirmDeleteCal.id) setCalFilter(null)
            deleteCalendar(confirmDeleteCal.id)
          }
          setConfirmDeleteCal(null)
        }}
      />
    </div>
  )
}

// ---- Month view -------------------------------------------------------------

function MonthView({
  year,
  month,
  todayISO,
  selectedDate,
  events,
  calendars,
  onSelectDate,
  onAddEvent,
}: {
  year: number
  month: number
  todayISO: string
  selectedDate: string
  events: CalendarEvent[]
  calendars: Calendar[]
  onSelectDate: (iso: string) => void
  onAddEvent?: (iso: string) => void
}) {
  // Only as many weeks as the month touches: no row that's all next month.
  const grid = useMemo(() => {
    const g = buildMonthGrid(year, month)
    while (g.length > 35 && g.slice(-7).every((d) => d.getMonth() !== month)) g.splice(-7)
    return g
  }, [year, month])
  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  return (
    <div className="flex min-h-0 flex-1 flex-col px-8 pb-6 pt-3">
      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1 shrink-0">
        {dayNamesShort.map((d) => (
          <div key={d} className="os-label px-2 py-2">
            {d}
          </div>
        ))}
      </div>

      {/* Date cells — fill all remaining height with 6 equal rows */}
      <div className="grid min-h-0 flex-1 grid-cols-7 gap-1.5" style={{ gridTemplateRows: `repeat(${grid.length / 7}, minmax(0, 1fr))` }}>
        {grid.map((date, i) => {
          const iso = toISODate(date)
          const isCurrentMonth = date.getMonth() === month
          const isToday = iso === todayISO
          const isSelected = iso === selectedDate
          const onDay = expandEventsOn(events, iso)
          const dayEvents = onDay.slice(0, 3)
          const overflow = onDay.length - 3

          return (
            <button
              key={i}
              type="button"
              onClick={() => onSelectDate(iso)}
              onDoubleClick={() => onAddEvent?.(iso)}
              className={cn(
                "relative flex min-h-0 flex-col overflow-hidden rounded-[14px] p-2 text-left transition-colors",
                isSelected && "bg-card shadow-[0_0_0_1px_var(--hairline)]",
                !isCurrentMonth && "opacity-40",
              )}
            >
              {/* Today wears the sun's color, the same disc as the rail's Home button. */}
              <span
                className={cn(
                  "-ml-1 -mt-1 flex size-9 shrink-0 items-center justify-center rounded-full font-display text-2xl leading-none tabular",
                  isToday && "bg-season-deep text-season-ink",
                )}
              >
                {date.getDate()}
              </span>
              {/* Events — a color dot and the title; the dot carries the calendar */}
              <div className="mt-1.5 flex w-full min-w-0 flex-col gap-0.5">
                {dayEvents.map((ev) => (
                  <span key={`${ev.id}:${ev.date}`} className="flex min-w-0 items-center gap-1.5 text-[0.8rem] leading-snug">
                    <span className={cn("size-1.5 shrink-0 rounded-full", memberBg[calColor(ev.calendarId)])} />
                    {!coversWholeDay(ev, iso) ? (
                      <span className="shrink-0 font-mono text-[0.7rem] tabular text-muted-foreground">{shortClock(hoursOn(ev, iso).from)}</span>
                    ) : null}
                    <span className="truncate text-foreground">{ev.title}</span>
                  </span>
                ))}
                {overflow > 0 ? <span className="os-label mt-0.5">+{overflow} more</span> : null}
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---- Week view --------------------------------------------------------------

function WeekView({
  anchorDate,
  todayISO,
  selectedDate,
  events,
  calendars,
  register,
  onSelectDate,
  onEdit,
}: {
  anchorDate: Date
  todayISO: string
  selectedDate: string
  events: CalendarEvent[]
  calendars: Calendar[]
  register: (id: string) => (el: HTMLElement | null) => void
  onSelectDate: (iso: string) => void
  onEdit?: (e: CalendarEvent) => void
}) {
  // Seven days from the one you're on: a wall looks ahead, so the week starts today.
  const days = Array.from({ length: 7 }, (_, i) => addDays(anchorDate, i))
  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  return (
    <div className="grid min-h-0 flex-1 grid-cols-7 gap-2 px-6 pb-6 pt-3">
      {days.map((d) => {
        const iso = toISODate(d)
        const isToday = iso === todayISO
        const isSelected = iso === selectedDate
        const list = expandEventsOn(events, iso)
        return (
          <section
            key={iso}
            className={cn(
              "flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto rounded-[18px] p-2 no-scrollbar",
              (isToday || isSelected) && "bg-card shadow-[0_0_0_1px_var(--hairline)]",
            )}
          >
            <button type="button" onClick={() => onSelectDate(iso)} className="flex items-center gap-2 px-1 pb-1 pt-0.5 text-left">
              <span
                className={cn(
                  "-ml-1 flex size-10 items-center justify-center rounded-full font-display text-[1.65rem] leading-none tabular",
                  isToday && "bg-season-deep text-season-ink",
                )}
              >
                {d.getDate()}
              </span>
              <span className="os-label">{isToday ? "Today" : dayNames[d.getDay()]}</span>
            </button>
            {list.map((ev) => (
              <button
                key={`${ev.id}:${ev.date}`}
                ref={register(ev.id) as React.RefCallback<HTMLButtonElement>}
                type="button"
                onClick={() => (onEdit ? onEdit(ev) : onSelectDate(iso))}
                className={cn(
                  "flex min-w-0 gap-2.5 rounded-[14px] border border-hairline px-2.5 py-2 text-left",
                  isToday || isSelected ? "bg-background" : "bg-card",
                )}
              >
                <span className={cn("w-1 shrink-0 self-stretch rounded-full", memberBg[calColor(ev.calendarId)])} aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block font-mono text-[0.68rem] text-muted-foreground">
                    {coversWholeDay(ev, iso) ? "All day" : formatClock(hoursOn(ev, iso).from)}
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-[0.9rem] leading-snug">{ev.title}</span>
                </span>
              </button>
            ))}
            {list.length === 0 ? <p className="px-1.5 text-sm text-muted-foreground/70">Nothing yet</p> : null}
          </section>
        )
      })}
    </div>
  )
}

// ---- Day view ---------------------------------------------------------------

function DayView({
  selectedDate,
  events,
  calendars,
  getMember,
  register,
  canManage,
  onEdit,
  onDelete,
}: {
  selectedDate: string
  events: CalendarEvent[]
  calendars: Calendar[]
  getMember: (id: string) => Member
  register: (id: string) => (el: HTMLElement | null) => void
  canManage: boolean
  onEdit: (e: CalendarEvent) => void
  onDelete: (e: CalendarEvent) => void
}) {
  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  const selDate = new Date(`${selectedDate}T00:00:00`)
  const dateLabel = `${dayNames[selDate.getDay()]}, ${monthNames[selDate.getMonth()]} ${selDate.getDate()}`

  // Group events by hour
  const byHour = useMemo(() => {
    const map = new Map<number, CalendarEvent[]>()
    for (const e of events) {
      const arr = map.get(e.start) ?? []
      arr.push(e)
      map.set(e.start, arr)
    }
    return map
  }, [events])

  const nowH = useNowHours()
  const isToday = selectedDate === homeTodayISO()
  const live = (e: CalendarEvent) => isToday && !coversWholeDay(e, selectedDate) && hoursOn(e, selectedDate).from <= nowH && hoursOn(e, selectedDate).to > nowH
  const over = (e: CalendarEvent) => isToday && !coversWholeDay(e, selectedDate) && hoursOn(e, selectedDate).to <= nowH

  return (
    <div className="mx-auto w-full max-w-5xl space-y-2.5 px-8 pb-8 pt-4">
      <div className="mb-1 flex items-center justify-between">
        <p className="os-label">
          {dateLabel} · {events.length} {events.length === 1 ? "event" : "events"}
        </p>
        <div className="flex -space-x-2">
          {Array.from(new Set(events.flatMap((e) => e.memberIds))).slice(0, 4).map((id) => (
            <MemberAvatar key={id} member={getMember(id)} size="sm" ring />
          ))}
        </div>
      </div>

      {events.length === 0 ? (
        <p className="py-16 font-display text-3xl italic text-muted-foreground">
          {calendars.length === 0 ? "Create a calendar to start adding events." : "No events for this day."}
        </p>
      ) : (
        events.map((event) => {
          const assignees = event.memberIds.map((id) => getMember(id))
          const now = live(event)
          return (
            <div
              key={`${event.id}:${event.date}`}
              ref={register(event.id) as React.RefCallback<HTMLDivElement>}
              className={cn("flex gap-4", over(event) && "opacity-50")}
            >
              <div className={cn("w-20 shrink-0 pt-4 font-mono text-[0.8rem] tabular", now ? "font-semibold text-foreground" : "text-muted-foreground")}>
                {now ? "Now" : eventTimeLabel(event, selectedDate)}
              </div>
              {/* The phone's event card: a member-color bar inside a soft card; the one on now is ringed in ink. */}
              <div
                className={cn(
                  "flex min-w-0 flex-1 items-center gap-3 rounded-[20px] border bg-card py-3 pl-4 pr-2",
                  now ? "border-foreground shadow-[inset_0_0_0_0.5px_var(--foreground)]" : "border-hairline",
                )}
              >
                <span className={cn("w-1 shrink-0 self-stretch rounded-full", memberBg[calColor(event.calendarId)])} aria-hidden />
                <button type="button" onClick={() => canManage && onEdit(event)} className="min-w-0 flex-1 text-left">
                  <p className={cn("truncate text-[1.15rem] leading-tight", now && "font-medium")}>{event.title}</p>
                  {event.endDate ? <p className="mt-1 text-xs text-muted-foreground">{eventRangeLabel(event)}</p> : null}
                  {eventRepeatLabel(event) ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <Repeat className="size-3" aria-hidden />
                      {eventRepeatLabel(event)}
                    </p>
                  ) : null}
                  {event.location ? (
                    <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                      <MapPin className="size-3" />
                      {event.location}
                    </p>
                  ) : null}
                </button>
                {assignees.length > 0 ? (
                  <div className="flex shrink-0 -space-x-2">
                    {assignees.slice(0, 4).map((m) => <MemberAvatar key={m.id} member={m} size="sm" ring />)}
                  </div>
                ) : null}
                {canManage ? <MoreMenu label={`${event.title} options`} items={editDelete(() => onEdit(event), () => onDelete(event))} /> : null}
              </div>
            </div>
          )
        })
      )}
    </div>
  )
}

/** Hours since midnight, refreshed each minute, so "Now" moves along. */
function useNowHours(): number {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now.getHours() + now.getMinutes() / 60
}

/** Today's date at home, checked each minute so the calendar turns over at midnight. */
function useHomeToday(): string {
  const [iso, setIso] = useState(homeTodayISO)
  useEffect(() => {
    const t = setInterval(() => setIso(homeTodayISO()), 60_000)
    return () => clearInterval(t)
  }, [])
  return iso
}

// ---- Time stepper -----------------------------------------------------------

/** A time you nudge by quarter hours with big − and + buttons; it wraps past midnight. */
function TimeStepper({ label, value, onChange }: { label: string; value: number; onChange: (h: number) => void }) {
  const step = (by: number) => onChange((((value + by) % 24) + 24) % 24)
  return (
    <div>
      <span className="os-label mb-2 block">{label}</span>
      <div className="flex h-[3.25rem] items-center justify-between rounded-[14px] border border-hairline bg-card px-1.5">
        <button type="button" aria-label={`${label} 15 minutes earlier`} onClick={() => step(-0.25)} className="flex size-10 items-center justify-center rounded-full bg-secondary text-lg">
          −
        </button>
        <span className="font-medium tabular">{formatClock(value)}</span>
        <button type="button" aria-label={`${label} 15 minutes later`} onClick={() => step(0.25)} className="flex size-10 items-center justify-center rounded-full bg-secondary text-lg">
          +
        </button>
      </div>
    </div>
  )
}

// ---- Calendars filter -------------------------------------------------------

/** One chip in the header for which calendars show; Manage lives at the bottom of its list. */
function CalendarsButton({
  calendars,
  value,
  onChange,
  onManage,
  label,
  color,
}: {
  calendars: Calendar[]
  value: string | null
  onChange: (id: string | null) => void
  onManage?: () => void
  label: string
  color?: MemberColor
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex h-12 items-center gap-2 rounded-full border border-hairline bg-card pl-4 pr-3 text-sm font-medium"
      >
        {color ? <span className={cn("size-2 rounded-full", memberBg[color])} aria-hidden /> : null}
        {label}
        <ChevronDown className="size-4 text-muted-foreground" />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden />
          <div className="pop-in absolute right-0 top-14 z-40 w-72 origin-top-right overflow-hidden rounded-[20px] border border-hairline bg-popover p-1.5 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.35)]">
            {[null, ...calendars].map((c) => {
              const on = (c?.id ?? null) === value
              return (
                <button
                  key={c?.id ?? "all"}
                  type="button"
                  onClick={() => {
                    onChange(c?.id ?? null)
                    setOpen(false)
                  }}
                  className={cn("flex h-12 w-full items-center gap-3 rounded-xl px-3 text-left text-[0.95rem]", on && "bg-secondary")}
                >
                  <span className={cn("size-2.5 rounded-full", c ? memberBg[c.color] : "bg-muted-foreground/40")} aria-hidden />
                  <span className="flex-1 truncate">{c ? c.name : "All calendars"}</span>
                  {on ? <Check className="size-4" /> : null}
                </button>
              )
            })}
            {onManage ? (
              <button
                type="button"
                onClick={() => {
                  setOpen(false)
                  onManage()
                }}
                className="mt-1 flex h-12 w-full items-center gap-3 rounded-xl border-t border-hairline px-3 text-left text-[0.95rem] text-muted-foreground"
              >
                <Settings2 className="size-4" />
                Manage calendars
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}

// ---- Manage calendars sheet -------------------------------------------------

type CalDraft = { name: string; color: MemberColor; memberIds: string[] }

function ManageCalendarsSheet({
  open,
  onClose,
  calendars,
  members,
  onAdd,
  onUpdate,
  onDelete,
  confirmDelete,
  setConfirmDelete,
}: {
  open: boolean
  onClose: () => void
  calendars: Calendar[]
  members: { id: string; name: string }[]
  onAdd: (c: Omit<Calendar, "id">) => void
  onUpdate: (id: string, patch: Partial<Omit<Calendar, "id">>) => void
  onDelete: (id: string) => void
  confirmDelete: Calendar | null
  setConfirmDelete: (c: Calendar | null) => void
}) {
  const [draft, setDraft] = useState<CalDraft>({ name: "", color: "coral", memberIds: [] })
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<CalDraft>({ name: "", color: "coral", memberIds: [] })

  const submit = () => {
    if (!draft.name.trim()) return
    onAdd({ name: draft.name.trim(), color: draft.color, memberIds: draft.memberIds })
    setDraft({ name: "", color: "coral", memberIds: [] })
  }

  const toggleMember = (id: string) =>
    setDraft((d) => ({
      ...d,
      memberIds: d.memberIds.includes(id) ? d.memberIds.filter((m) => m !== id) : [...d.memberIds, id],
    }))

  const startEdit = (c: Calendar) => {
    setEditingId(c.id)
    setEditDraft({ name: c.name, color: c.color, memberIds: c.memberIds })
  }

  const saveEdit = (id: string) => {
    if (!editDraft.name.trim()) return
    onUpdate(id, { name: editDraft.name.trim(), color: editDraft.color, memberIds: editDraft.memberIds })
    setEditingId(null)
  }

  const toggleEditMember = (id: string) =>
    setEditDraft((d) => ({
      ...d,
      memberIds: d.memberIds.includes(id) ? d.memberIds.filter((m) => m !== id) : [...d.memberIds, id],
    }))

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Manage calendars"
      footer={
        <button
          type="button"
          onClick={submit}
          disabled={!draft.name.trim()}
          className="w-full rounded-full bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add calendar
        </button>
      }
    >
      {/* Existing calendars */}
      <div className="space-y-2">
        {calendars.map((c) =>
          editingId === c.id ? (
            <div key={c.id} className="space-y-3 rounded-[20px] border border-primary/50 p-3">
              <Field label="Name">
                <input
                  value={editDraft.name}
                  onChange={(e) => setEditDraft((d) => ({ ...d, name: e.target.value }))}
                  className={inputClass}
                />
              </Field>
              <Field label="Color">
                <div className="flex items-center gap-2">
                  {calendarColors.map((col) => (
                    <button
                      key={col}
                      type="button"
                      aria-label={`Color ${col}`}
                      onClick={() => setEditDraft((d) => ({ ...d, color: col }))}
                      className={cn(
                        "flex size-8 items-center justify-center rounded-full transition-all",
                        memberBg[col],
                        editDraft.color === col ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card" : "",
                      )}
                    >
                      {editDraft.color === col ? <Check className="size-4 text-white" /> : null}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Shared with">
                <div className="flex flex-wrap gap-2">
                  {members.map((m) => {
                    const on = editDraft.memberIds.includes(m.id)
                    return (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => toggleEditMember(m.id)}
                        className={cn(
                          "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                          on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                        )}
                      >
                        {m.name}
                      </button>
                    )
                  })}
                  {members.length === 0 ? (
                    <span className="text-xs text-muted-foreground">Add family members first.</span>
                  ) : null}
                </div>
              </Field>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => saveEdit(c.id)}
                  disabled={!editDraft.name.trim()}
                  className="flex-1 rounded-full bg-primary py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  aria-label="Cancel editing"
                  className="flex size-12 items-center justify-center rounded-[12px] border border-border text-muted-foreground hover:bg-secondary"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          ) : (
            <div key={c.id} className="flex items-center gap-3 rounded-[20px] border border-border/70 p-3">
              <span className={cn("size-3 shrink-0 rounded-full", memberBg[c.color])} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{c.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {c.memberIds.length} {c.memberIds.length === 1 ? "member" : "members"}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  aria-label={`Edit ${c.name}`}
                  onClick={() => startEdit(c)}
                  className="flex size-12 items-center justify-center rounded-[12px] text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setConfirmDelete(c)}
                  className="flex size-12 items-center justify-center rounded-[12px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </div>
          ),
        )}
        {calendars.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">No calendars yet. Create your first below.</p>
        ) : null}
      </div>

      {/* New calendar form */}
      <div className="mt-4 space-y-3 rounded-[20px] border border-border/70 p-3">
        <p className="text-sm font-semibold">New calendar</p>
        <Field label="Name">
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Friends, Work, Sports…"
            className={inputClass}
          />
        </Field>
        <Field label="Color">
          <div className="flex items-center gap-2">
            {calendarColors.map((col) => (
              <button
                key={col}
                type="button"
                aria-label={`Color ${col}`}
                onClick={() => setDraft((d) => ({ ...d, color: col }))}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full transition-all",
                  memberBg[col],
                  draft.color === col ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-card" : "",
                )}
              >
                {draft.color === col ? <Check className="size-4 text-white" /> : null}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Shared with">
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const on = draft.memberIds.includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleMember(m.id)}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                    on ? "bg-primary text-primary-foreground" : "bg-secondary text-foreground",
                  )}
                >
                  {m.name}
                </button>
              )
            })}
            {members.length === 0 ? (
              <span className="text-xs text-muted-foreground">Add family members first.</span>
            ) : null}
          </div>
        </Field>
      </div>

    </BottomSheet>
  )
}
