import { Router, type Request, type Response } from "express"
import { v4 as uuidv4 } from "uuid"
import { getDb, toBool } from "../db"
import { callerMember, managesChores } from "../lib/household-member"
import { homeToday } from "../lib/home-time"
import { recordCompletion } from "../services/points"
import { requireAuth, type AuthRequest } from "../middleware/auth"
import { broadcast } from "../broadcaster"
import type { Chore } from "../types"
import { logActivity } from "./activity-logs"

const router = Router()
router.use(requireAuth)

/** Today's date at home (yyyy-mm-dd). Repeating chores reset at home midnight. */
export function hubToday(): string {
  return homeToday()
}

function parseRepeatDays(value: unknown): number[] | undefined {
  if (typeof value !== "string" || !value) return undefined
  const days = value.split(",").map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  return days.length ? days : undefined
}

/** A picture key: short lowercase id, or null to clear it. */
function iconColumn(value: unknown): string | null {
  return typeof value === "string" && /^[a-z0-9-]{1,32}$/.test(value) ? value : null
}

/** Normalise a repeatDays body field to its column value ("1,3,5" or null). */
function repeatDaysColumn(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  const days = [...new Set(value.map(Number))].filter((n) => Number.isInteger(n) && n >= 0 && n <= 6).sort()
  return days.length ? days.join(",") : null
}

/**
 * Whether the caller may check a chore off (or back on): the person it's
 * assigned to, a parent with chore permissions, an admin, or the shared wall
 * display, which can't tell who is tapping it.
 */
function canComplete(user: AuthRequest["user"], choreMemberId: string | null): boolean {
  return managesChores(user) || callerMember(user)?.id === choreMemberId
}

const SUMMER_MODES = ["same", "off", "only", "days"] as const
function summerModeColumn(v: unknown): Chore["summerMode"] {
  return SUMMER_MODES.includes(v as Chore["summerMode"]) ? (v as Chore["summerMode"]) : "same"
}

export function rowToChore(r: Record<string, unknown>): Chore {
  const repeatDays = parseRepeatDays(r.repeat_days)
  const doneOn = (r.done_on as string) ?? undefined
  return {
    id: r.id as string,
    householdId: r.household_id as string,
    memberId: (r.member_id as string) ?? undefined,
    title: r.title as string,
    // A repeating chore is only done if it was completed today.
    done: repeatDays ? doneOn === hubToday() : toBool(r.done),
    points: r.points as number,
    due: r.due as string,
    repeatDays,
    doneOn,
    icon: (r.icon as string) ?? undefined,
    keepWhileAway: toBool(r.keep_while_away),
    summerMode: summerModeColumn(r.summer_mode),
    summerDays: parseRepeatDays(r.summer_days) ?? [],
    createdAt: r.created_at as string,
  }
}

router.get("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const rows = getDb()
    .prepare("SELECT * FROM chores WHERE household_id = ? ORDER BY created_at")
    .all(householdId) as Record<string, unknown>[]
  res.json(rows.map(rowToChore))
})

router.post("/", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { title, memberId, done = false, points = 0, due = "", repeatDays, icon, keepWhileAway = false, summerMode, summerDays } = req.body as {
    title?: string; memberId?: string; done?: boolean; points?: number; due?: string; repeatDays?: number[]; icon?: string; keepWhileAway?: boolean
    summerMode?: string; summerDays?: number[]
  }
  if (!title?.trim()) { res.status(400).json({ error: "title is required." }); return }
  const db = getDb()
  const id = uuidv4()
  db.prepare(
    "INSERT INTO chores (id, household_id, member_id, title, done, points, due, repeat_days, done_on, icon, keep_while_away, summer_mode, summer_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, householdId, memberId ?? null, title.trim(), done ? 1 : 0, points, due, repeatDaysColumn(repeatDays), done ? hubToday() : null, iconColumn(icon), keepWhileAway ? 1 : 0,
    summerModeColumn(summerMode), repeatDaysColumn(summerDays))
  const row = db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown>
  const chore = rowToChore(row)
  logActivity(req, { action: "chore.create", resourceType: "chore", resourceId: chore.id, resourceName: chore.title })
  broadcast(householdId, "chores:created", chore)
  res.status(201).json(chore)
})

router.patch("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const currentRow = db.prepare("SELECT * FROM chores WHERE id = ? AND household_id = ?").get(id, householdId) as
    | Record<string, unknown>
    | undefined
  const current = currentRow ? { member_id: (currentRow.member_id as string) ?? null } : undefined
  if (!currentRow || !current) {
    res.status(404).json({ error: "Chore not found." }); return
  }
  const body = req.body as Record<string, unknown>
  if (body.done !== undefined && !canComplete((req as AuthRequest).user, current.member_id)) {
    res.status(403).json({ error: "Only the person this chore is for, or a parent, can check it off." }); return
  }
  const sets: string[] = []; const vals: unknown[] = []
  if (body.title !== undefined) { sets.push("title = ?"); vals.push(String(body.title).trim()) }
  if ("memberId" in body) { sets.push("member_id = ?"); vals.push(body.memberId ?? null) }
  if (body.done !== undefined) {
    sets.push("done = ?", "done_on = ?")
    vals.push(body.done ? 1 : 0, body.done ? hubToday() : null)
  }
  if (body.points !== undefined) { sets.push("points = ?"); vals.push(body.points) }
  if (body.due !== undefined) { sets.push("due = ?"); vals.push(body.due) }
  if ("repeatDays" in body) { sets.push("repeat_days = ?"); vals.push(repeatDaysColumn(body.repeatDays)) }
  if ("icon" in body) { sets.push("icon = ?"); vals.push(iconColumn(body.icon)) }
  if (body.keepWhileAway !== undefined) { sets.push("keep_while_away = ?"); vals.push(body.keepWhileAway ? 1 : 0) }
  if (body.summerMode !== undefined) { sets.push("summer_mode = ?"); vals.push(summerModeColumn(body.summerMode)) }
  if ("summerDays" in body) { sets.push("summer_days = ?"); vals.push(repeatDaysColumn(body.summerDays)) }
  if (sets.length === 0) { res.status(400).json({ error: "No fields to update." }); return }
  vals.push(id, householdId)
  const wasDone = rowToChore(currentRow).done
  db.transaction(() => {
    db.prepare(`UPDATE chores SET ${sets.join(", ")} WHERE id = ? AND household_id = ?`).run(...vals)
    // Points history: only an actual change of done-today counts, so a repeated tap can't farm points.
    if (body.done !== undefined && Boolean(body.done) !== wasDone) {
      const before = rowToChore(currentRow)
      recordCompletion(householdId, { id, title: before.title, points: before.points, memberId: before.memberId ?? null }, Boolean(body.done), hubToday())
    }
  })()
  const updated = db.prepare("SELECT * FROM chores WHERE id = ?").get(id) as Record<string, unknown>
  const chore = rowToChore(updated)
  // Checking off is the moment worth seeing; other edits read as "changed".
  const toggled = body.done !== undefined && Boolean(body.done) !== wasDone
  const onlyDone = Object.keys(body).every((k) => k === "done")
  if (toggled || !onlyDone) {
    logActivity(req, {
      action: toggled ? (body.done ? "chore.complete" : "chore.uncomplete") : "chore.update",
      resourceType: "chore", resourceId: chore.id, resourceName: chore.title,
    })
  }
  broadcast(householdId, "chores:updated", chore)
  res.json(chore)
})

router.delete("/:id", (req: Request, res: Response) => {
  const householdId = (req as AuthRequest).user.householdId!
  const { id } = req.params
  const db = getDb()
  const gone = db.prepare("SELECT title FROM chores WHERE id = ? AND household_id = ?").get(id, householdId) as { title: string } | undefined
  if (!gone) {
    res.status(404).json({ error: "Chore not found." }); return
  }
  db.prepare("DELETE FROM chores WHERE id = ? AND household_id = ?").run(id, householdId)
  logActivity(req, { action: "chore.delete", resourceType: "chore", resourceId: id, resourceName: gone.title })
  broadcast(householdId, "chores:deleted", id)
  res.status(204).end()
})

export { router as choresRouter }
