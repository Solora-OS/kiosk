"use client"

import { useEffect, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight, MapPin, Plus, Repeat, Settings2, Trash2, Check, Pencil, X } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  type CalendarEvent,
  type Calendar,
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
import { ActionRow } from "@/components/ui/reusables/action-row"
import { BottomSheet, Field, inputClass } from "@/components/ui/reusables/bottom-sheet"
import { ConfirmDialog } from "@/components/ui/reusables/confirm-dialog"
import { RepeatPicker } from "@/components/ui/reusables/repeat-picker"
import { CountdownTiles } from "@/components/ui/reusables/countdown-tiles"
import { AwayBanner } from "@/components/ui/reusables/away-banner"
import { useHighlight, useStore } from "@/lib/store"

const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
const dayNamesShort = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]
const monthNames = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const calendarColors: MemberColor[] = ["blue", "coral", "teal", "amber", "pink", "green"]

function formatHour(h: number) {
  const ampm = h < 12 ? "AM" : "PM"
  const base = h % 12 === 0 ? 12 : h % 12
  return `${base}:00 ${ampm}`
}

/** Every quarter hour of the day, as hours since midnight. */
const quarterHours = Array.from({ length: 96 }, (_, i) => i / 4)

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

function startOfWeek(d: Date): Date {
  const r = new Date(d)
  r.setDate(r.getDate() - r.getDay())
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
  const today = useMemo(() => new Date(), [])
  const todayISO = toISODate(today)

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
      return selDateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })
    }
    if (viewMode === "week") {
      const ws = startOfWeek(selDateObj)
      const we = addDays(ws, 6)
      if (ws.getMonth() === we.getMonth()) {
        return `${monthNames[ws.getMonth()]} ${ws.getDate()}–${we.getDate()}, ${ws.getFullYear()}`
      }
      return `${monthNames[ws.getMonth()]} ${ws.getDate()} – ${monthNames[we.getMonth()]} ${we.getDate()}, ${we.getFullYear()}`
    }
    return `${monthNames[viewMonth]} ${viewYear}`
  }, [viewMode, selDateObj, viewMonth, viewYear])

  // ---- event helpers --------------------------------------------------------

  const eventsForDate = (iso: string) =>
    expandEventsOn(filteredEvents, iso)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ---- toolbar -------------------------------------------------------- */}
      <div className="relative z-10 space-y-4 px-8 pb-4 pt-5">
        <AwayBanner />
        <CountdownTiles events={events} size="lg" />
        <div className="flex items-center gap-4">
          <div className="flex min-w-0 flex-1 items-baseline gap-4">
            <span className="truncate font-display text-4xl leading-none">{periodLabel}</span>
            <button
              type="button"
              onClick={goToday}
              className="os-label flex h-12 shrink-0 items-center rounded-md border border-border px-4 transition-colors hover:text-foreground"
            >
              Today
            </button>
          </div>

          <div className="flex shrink-0 items-center">
            <button
              type="button"
              onClick={navigatePrev}
              aria-label="Previous"
              className="flex size-12 items-center justify-center rounded-l-md border border-border text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
            </button>
            <button
              type="button"
              onClick={navigateNext}
              aria-label="Next"
              className="-ml-px flex size-12 items-center justify-center rounded-r-md border border-border text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </button>
          </div>

          {/* View toggle */}
          <div className="grid h-12 shrink-0 grid-cols-3 rounded-md bg-secondary p-1">
            {(["day", "week", "month"] as ViewMode[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className={cn(
                  "rounded-[5px] px-4 text-sm capitalize transition-colors",
                  viewMode === v ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border)]" : "text-muted-foreground",
                )}
              >
                {v}
              </button>
            ))}
          </div>

          {canManage && calendars.length > 0 ? (
            <button type="button" onClick={() => openAdd(selectedDate)} className="os-button !min-h-12">
              <Plus className="size-4" />
              Event
            </button>
          ) : null}
        </div>

        {/* Calendar filters */}
        <div className="no-scrollbar flex items-center gap-6 overflow-x-auto">
          <FilterChip label="All calendars" active={calFilter === null} onClick={() => setCalFilter(null)} />
          {calendars.map((c) => (
            <FilterChip
              key={c.id}
              label={c.name}
              color={c.color}
              active={calFilter === c.id}
              onClick={() => setCalFilter(c.id)}
            />
          ))}
          {canManage ? (
            <button
              type="button"
              onClick={() => setManageOpen(true)}
              aria-label="Manage calendars"
              className="flex h-12 shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <Settings2 className="size-4" />
              Manage
            </button>
          ) : null}
        </div>
      </div>

      {/* ---- views ---------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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
            getMember={getMember}
            register={register}
            onSelectDate={(iso) => {
              setSelectedDate(iso)
              switchView("day")
            }}
            onEdit={canManage ? openEdit : undefined}
            onDelete={canManage ? requestDelete : undefined}
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
        <Field label="Calendar">
          <select
            value={form.calendarId}
            onChange={(e) => setForm((f) => ({ ...f, calendarId: e.target.value }))}
            className={inputClass}
          >
            {calendars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
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
            <div className="flex gap-3">
              <Field label="Starts">
                <select
                  value={form.start}
                  onChange={(e) => {
                    const start = Number(e.target.value)
                    // Keep the event's length when the start moves.
                    setForm((f) => {
                      const length = (f.end - f.start + 24) % 24 || 1
                      return { ...f, start, end: (start + length) % 24 }
                    })
                  }}
                  className={inputClass}
                >
                  {quarterHours.map((h) => (
                    <option key={h} value={h}>
                      {formatClock(h)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Ends">
                <select
                  value={form.end}
                  onChange={(e) => setForm((f) => ({ ...f, end: Number(e.target.value) }))}
                  className={inputClass}
                >
                  {quarterHours.map((h) => (
                    <option key={h} value={h}>
                      {formatClock(h)}
                    </option>
                  ))}
                </select>
              </Field>
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
        <Field label="Remind">
          <select
            value={form.reminderMinutes ?? "none"}
            onChange={(e) => setForm((f) => ({ ...f, reminderMinutes: e.target.value === "none" ? null : Number(e.target.value) }))}
            className={inputClass}
          >
            {reminderOptions(form.allDay).map((o) => (
              <option key={o.label} value={o.value ?? "none"}>{o.label}</option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            {form.memberIds.length ? "Sent to the people assigned." : "Sent to everyone in the family."}
          </span>
        </Field>
        <div className="flex items-center justify-between gap-3 py-1">
          <span>
            <span className="block text-sm font-medium">Count down to this</span>
            <span className="block text-xs text-muted-foreground">Shows &ldquo;9 sleeps until…&rdquo; at the top of the calendar</span>
          </span>
          <Switch label="Count down to this" on={form.countdown} onChange={(countdown) => setForm((f) => ({ ...f, countdown }))} />
        </div>
        <Field label="Assigned to">
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const on = form.memberIds.includes(m.id)
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => toggleFormMember(m.id)}
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
  const grid = useMemo(() => buildMonthGrid(year, month), [year, month])
  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  return (
    <div className="flex min-h-0 flex-1 flex-col px-8 pb-6">
      {/* Day headers */}
      <div className="grid grid-cols-7 mb-1 shrink-0">
        {dayNamesShort.map((d) => (
          <div key={d} className="os-label px-2 py-2">
            {d}
          </div>
        ))}
      </div>

      {/* Date cells — fill all remaining height with 6 equal rows */}
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6 border-l border-t border-hairline">
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
                "relative flex min-h-0 flex-col overflow-hidden border-b border-r border-hairline p-2 text-left transition-colors",
                isSelected ? "bg-card" : "hover:bg-card/60",
                !isCurrentMonth && "text-muted-foreground/40",
              )}
            >
              {isToday ? <span aria-hidden className="absolute inset-x-0 top-0 h-[3px] bg-season" /> : null}
              <span
                className={cn(
                  "font-display text-2xl leading-none tabular",
                  isToday && "text-season",
                )}
              >
                {date.getDate()}
              </span>
              {/* Events — a color dot and the title; the dot carries the calendar */}
              <div className="mt-1.5 flex w-full min-w-0 flex-col gap-0.5">
                {dayEvents.map((ev) => (
                  <span key={`${ev.id}:${ev.date}`} className="flex min-w-0 items-center gap-1.5 text-[0.8rem] leading-snug">
                    <span className={cn("size-1.5 shrink-0 rounded-full", memberBg[calColor(ev.calendarId)])} />
                    <span className={cn("truncate", isCurrentMonth ? "text-foreground" : "text-muted-foreground/50")}>{ev.title}</span>
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
  getMember,
  register,
  onSelectDate,
  onEdit,
  onDelete,
}: {
  anchorDate: Date
  todayISO: string
  selectedDate: string
  events: CalendarEvent[]
  calendars: Calendar[]
  getMember: (id: string) => { id: string; name: string; color: MemberColor; initial: string; role: string }
  register: (id: string) => (el: HTMLElement | null) => void
  onSelectDate: (iso: string) => void
  onEdit?: (e: CalendarEvent) => void
  onDelete?: (e: CalendarEvent) => void
}) {
  const ws = startOfWeek(anchorDate)
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i))
  const calColor = (id: string): MemberColor => calendars.find((c) => c.id === id)?.color ?? "blue"

  return (
    <div className="overflow-x-auto">
      {/* Day header strip */}
      <div className="sticky top-0 z-10 flex border-b border-hairline bg-background pl-20 pr-8">
        {days.map((d) => {
          const iso = toISODate(d)
          const isToday = iso === todayISO
          const isSelected = iso === selectedDate
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onSelectDate(iso)}
              className={cn(
                "relative flex flex-1 flex-col items-start gap-1 px-2 py-3 transition-colors",
                isSelected ? "bg-card" : "hover:bg-card/60",
              )}
            >
              {isToday ? <span aria-hidden className="absolute inset-x-2 top-0 h-[3px] bg-season" /> : null}
              <span className="os-label">
                {dayNamesShort[d.getDay()]}
              </span>
              <span
                className={cn(
                  "font-display text-3xl leading-none tabular",
                  isToday ? "text-season" : "text-foreground",
                )}
              >
                {d.getDate()}
              </span>
            </button>
          )
        })}
      </div>

      {/* All-day strip — all-day events and the middle days of multi-day ones */}
      {days.some((d) => expandEventsOn(events, toISODate(d)).some((e) => coversWholeDay(e, toISODate(d)))) ? (
        <div className="flex border-b border-hairline pr-8">
          <div className="w-20 shrink-0 pr-3 pt-1.5 text-right font-mono text-[0.7rem] uppercase text-muted-foreground">All day</div>
          <div className="flex flex-1 gap-px py-1">
            {days.map((d) => {
              const iso = toISODate(d)
              return (
                <div key={iso} className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {expandEventsOn(events, iso).filter((e) => coversWholeDay(e, iso)).map((ev) => (
                    <button
                      key={`${ev.id}:${ev.date}`}
                      type="button"
                      onClick={() => onEdit?.(ev)}
                      className="relative mx-0.5 truncate rounded-[4px] border border-border bg-card py-0.5 pl-2.5 pr-1 text-left text-[0.8rem] font-medium"
                    >
                      <span aria-hidden className={cn("absolute inset-y-1 left-1 w-[3px] rounded-full", memberBg[calColor(ev.calendarId)])} />
                      {ev.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}

      {/* Hourly grid */}
      <div className="relative">
        {/* Hour rows */}
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} className="flex border-b border-hairline pr-8" style={{ minHeight: 48 }}>
            <div className="w-20 shrink-0 pr-3 pt-1 text-right font-mono text-[0.7rem] uppercase text-muted-foreground">
              {h === 0 ? "" : formatHour(h)}
            </div>
            <div className="flex flex-1 gap-px">
              {days.map((d) => {
                const iso = toISODate(d)
                const dayEvs = expandEventsOn(events, iso).filter(
                  (e) => !coversWholeDay(e, iso) && Math.floor(hoursOn(e, iso).from) === h,
                )
                return (
                  <div key={iso} className="flex-1 relative min-w-0">
                    {dayEvs.map((ev) => (
                      <div
                        key={`${ev.id}:${ev.date}`}
                        ref={register(ev.id) as React.RefCallback<HTMLDivElement>}
                        className="absolute inset-x-0.5 cursor-pointer overflow-hidden rounded-[4px] border border-border bg-card py-1 pl-2.5 pr-1 text-[0.8rem] font-medium text-foreground transition-colors hover:border-foreground/40"
                        style={{
                          top: 2 + (hoursOn(ev, iso).from % 1) * 48,
                          minHeight: Math.max(hoursOn(ev, iso).to - hoursOn(ev, iso).from, 0.5) * 48 - 4,
                        }}
                        onClick={() => onEdit?.(ev)}
                      >
                        <span aria-hidden className={cn("absolute inset-y-1 left-1 w-[3px] rounded-full", memberBg[calColor(ev.calendarId)])} />
                        <span className="block truncate">{ev.title}</span>
                        {hoursOn(ev, iso).to - hoursOn(ev, iso).from > 1 && ev.location ? (
                          <span className="mt-0.5 flex items-center gap-0.5 truncate text-muted-foreground">
                            <MapPin className="size-2.5 inline" />{ev.location}
                          </span>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
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
  getMember: (id: string) => { id: string; name: string; color: MemberColor; initial: string; role: string }
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

  return (
    <div className="space-y-1 px-8 pb-8 pt-2">
      {/* Day summary */}
      <div className="flex items-center justify-between mb-3">
        <p className="os-label">
          {dateLabel} · {events.length} {events.length === 1 ? "event" : "events"}
        </p>
        <div className="flex -space-x-2">
          {Array.from(new Set(events.flatMap((e) => e.memberIds))).slice(0, 4).map((id) => {
            const m = getMember(id)
            return <MemberAvatar key={id} member={m} size="sm" ring />
          })}
        </div>
      </div>

      {/* Timeline */}
      {events.length === 0 ? (
        <p className="py-16 font-display text-3xl italic text-muted-foreground">
          {calendars.length === 0 ? "Create a calendar to start adding events." : "No events for this day."}
        </p>
      ) : (
        <div className="border-t border-hairline">
          {events.map((event) => {
            const assignees = event.memberIds.map((id) => getMember(id))
            const color = calColor(event.calendarId)
            return (
              <div key={`${event.id}:${event.date}`} ref={register(event.id) as React.RefCallback<HTMLDivElement>} className="flex gap-6 border-b border-hairline py-2">
                <div className="w-20 shrink-0 pt-4 font-mono text-[0.85rem] tabular text-muted-foreground">
                  {eventTimeLabel(event, selectedDate)}
                </div>
                <div className="min-w-0 flex-1">
                  <ActionRow
                    onEdit={canManage ? () => onEdit(event) : undefined}
                    onDelete={canManage ? () => onDelete(event) : undefined}
                  >
                    <div className="flex bg-background">
                      <span className={cn("my-3 w-[3px] shrink-0 rounded-full", memberBg[color])} aria-hidden />
                      <div className="min-w-0 flex-1 px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-xl leading-tight">{event.title}</p>
                            {event.endDate ? (
                              <p className="mt-1 text-xs text-muted-foreground">{eventRangeLabel(event)}</p>
                            ) : null}
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
                          </div>
                          {assignees.length === 1 ? (
                            <span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
                              <span className={cn("size-2 rounded-full", memberBg[assignees[0].color])} />
                              {assignees[0].name}
                            </span>
                          ) : assignees.length > 1 ? (
                            <div className="flex shrink-0 -space-x-2">
                              {assignees.slice(0, 4).map((m) => (
                                <MemberAvatar key={m.id} member={m} size="sm" ring />
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </ActionRow>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---- Filter chip ------------------------------------------------------------

function FilterChip({
  label,
  color,
  active,
  onClick,
}: {
  label: string
  color?: MemberColor
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex h-12 shrink-0 items-center gap-2 text-[0.95rem] transition-colors",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {color ? <span className={cn("size-2 rounded-full", memberBg[color])} aria-hidden /> : null}
      {label}
      <span aria-hidden className={cn("absolute inset-x-0 -bottom-0.5 h-[2px] rounded-full bg-foreground transition-opacity", active ? "opacity-100" : "opacity-0")} />
    </button>
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
          className="w-full rounded-md bg-primary py-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          Add calendar
        </button>
      }
    >
      {/* Existing calendars */}
      <div className="space-y-2">
        {calendars.map((c) =>
          editingId === c.id ? (
            <div key={c.id} className="space-y-3 rounded-md border border-primary/50 p-3">
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
                  className="flex-1 rounded-md bg-primary py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditingId(null)}
                  aria-label="Cancel editing"
                  className="flex size-12 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary"
                >
                  <X className="size-4" />
                </button>
              </div>
            </div>
          ) : (
            <div key={c.id} className="flex items-center gap-3 rounded-md border border-border/70 p-3">
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
                  className="flex size-12 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
                >
                  <Pencil className="size-4" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${c.name}`}
                  onClick={() => setConfirmDelete(c)}
                  className="flex size-12 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
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
      <div className="mt-4 space-y-3 rounded-md border border-border/70 p-3">
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
