/**
 * household-member.ts — who a request is from, in household terms.
 */

import { getDb, parseJson } from "../db"
import type { AuthRequest } from "../middleware/auth"

export type CallerMember = { id: string; role: string; permissions: string[] }

/** The member the caller signs in as, or null (the wall display, or a user with no member). */
export function callerMember(user: AuthRequest["user"]): CallerMember | null {
  const row = getDb()
    .prepare("SELECT id, role, permissions FROM members WHERE user_id = ? AND household_id = ?")
    .get(user.userId, user.householdId ?? "") as { id: string; role: string; permissions: string } | undefined
  return row ? { id: row.id, role: row.role, permissions: parseJson<string[]>(row.permissions, []) } : null
}

/**
 * Whether the caller manages `area` for the whole family: admins, members given
 * that permission, and the shared wall display (which can't tell who is
 * tapping it).
 */
export function manages(user: AuthRequest["user"], area: "calendar" | "chores" | "lists" | "meals" | "hub"): boolean {
  if (user.role === "kiosk") return true
  const m = callerMember(user)
  return !!m && (m.role === "admin" || m.permissions.includes(area))
}

/**
 * Parents with list rights, admins and the wall manage lists: create, rename
 * and delete them, and remove anyone's items. Everyone else can add and tick.
 */
export function managesLists(user: AuthRequest["user"]): boolean {
  return manages(user, "lists")
}

/**
 * Parents with chore rights, admins, and the shared wall display (which can't
 * tell who is tapping it) can act on anyone's chores and rewards.
 */
export function managesChores(user: AuthRequest["user"]): boolean {
  return manages(user, "chores")
}
