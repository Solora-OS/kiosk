/**
 * GET /api/v1/snapshot
 *
 * Returns the full household dataset in a single response.
 * Used by the kiosk display (which has a device token, not a user JWT) and
 * by the React app on first load when it wants to hydrate all tables at once.
 *
 * Auth: requireAuth — the device token or a user JWT both satisfy this
 * middleware; the household_id is resolved from the verified payload.
 */

import { Router } from "express"
import { requireAuth } from "../middleware/auth"
import { getDb, parseJson, toBool } from "../db"
import { rowToChore } from "./chores"
import { rowToEvent } from "./events"
import { rowToMeal } from "./meals"
import { rowToItem } from "./lists"
import { notificationsFor } from "./notifications"
import { seasonSettings } from "./seasons"
import { summerBreak } from "./summer"
import { homeTimeZone } from "../lib/home-time"

export const snapshotRouter = Router()

type Row = Record<string, unknown>

snapshotRouter.get("/", requireAuth, (req, res) => {
  const db = getDb()
  const { householdId: hid, sub: userId } = (req as import("../middleware/auth").AuthRequest).user

  // Guard against undefined/null/empty — kiosk device not yet paired, or
  // token resolved no household from DB. Return empty collections rather than
  // passing an invalid bind param to SQLite (which throws and causes a 500).
  if (hid == null || hid === "") {
    res.json({ members: [], calendars: [], events: [], chores: [], lists: [], meals: [], notifications: [], photos: [], timeZone: homeTimeZone() })
    return
  }

  try {
    const memberRows = db
      .prepare("SELECT * FROM members WHERE household_id = ? ORDER BY created_at ASC")
      .all(hid) as Row[]
    const members = memberRows.map((r) => ({
      id: r.id as string,
      householdId: r.household_id as string,
      userId: (r.user_id as string) ?? undefined,
      name: r.name as string,
      initial: r.initial as string,
      color: r.color as string,
      role: r.role as string,
      dob: (r.dob as string) ?? undefined,
      account: (r.account as string) ?? undefined,
      permissions: parseJson<string[]>(r.permissions, []),
      pending: toBool(r.pending),
      createdAt: r.created_at as string,
    }))

    const calendarRows = db
      .prepare("SELECT * FROM calendars WHERE household_id = ? ORDER BY created_at ASC")
      .all(hid) as Row[]
    const calendars = calendarRows.map((r) => ({
      id: r.id as string,
      householdId: r.household_id as string,
      name: r.name as string,
      color: r.color as string,
      memberIds: parseJson<string[]>(r.member_ids, []),
      createdAt: r.created_at as string,
    }))

    const eventRows = db
      .prepare("SELECT * FROM events WHERE household_id = ? ORDER BY date ASC, start_hour ASC")
      .all(hid) as Row[]
    const events = eventRows.map(rowToEvent)

    const choreRows = db
      .prepare("SELECT * FROM chores WHERE household_id = ? ORDER BY created_at ASC")
      .all(hid) as Row[]
    const chores = choreRows.map(rowToChore)

    const listRows = db
      .prepare("SELECT * FROM lists WHERE household_id = ? ORDER BY created_at ASC")
      .all(hid) as Row[]
    const itemRows = db
      .prepare(
        `SELECT li.* FROM list_items li
         JOIN lists l ON l.id = li.list_id
         WHERE l.household_id = ?
         ORDER BY li.position ASC, li.created_at ASC`,
      )
      .all(hid) as Row[]
    const itemsByList = new Map<string, Row[]>()
    for (const item of itemRows) {
      const lid = item.list_id as string
      if (!itemsByList.has(lid)) itemsByList.set(lid, [])
      itemsByList.get(lid)!.push(item)
    }
    const lists = listRows.map((l) => ({
      id: l.id as string,
      householdId: l.household_id as string,
      title: l.title as string,
      color: l.color as string,
      createdAt: l.created_at as string,
      items: (itemsByList.get(l.id as string) ?? []).map(rowToItem),
    }))

    const mealRows = db
      .prepare("SELECT * FROM meals WHERE household_id = ? ORDER BY created_at ASC")
      .all(hid) as Row[]
    const meals = mealRows.map(rowToMeal)

    // This person's notifications (and the household-wide ones), with their read state.
    const notifications = notificationsFor((req as import("../middleware/auth").AuthRequest).user).slice(0, 100)

    // photos table may not exist in older DB files before migration
    let photos: unknown[] = []
    try {
      const photoRows = db
        .prepare("SELECT * FROM photos WHERE household_id = ? ORDER BY created_at DESC")
        .all(hid) as Row[]
      photos = photoRows.map((r) => ({
        id: r.id as string,
        householdId: r.household_id as string,
        filename: r.filename as string,
        src: r.src as string,
        caption: r.caption as string,
        createdAt: r.created_at as string,
      }))
    } catch {
      /* table not yet migrated — return empty */
    }

    res.json({ members, calendars, events, chores, lists, meals, notifications, photos, timeZone: homeTimeZone(), seasons: seasonSettings(hid), summer: summerBreak(hid) })
  } catch (err) {
    console.error("[snapshot] query error:", err)
    res.status(500).json({ error: "Failed to load snapshot.", detail: String(err) })
  }
})
