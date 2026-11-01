/**
 * points.ts — what chores earn and rewards cost.
 *
 * Every chore checked off writes a completion (unticking removes it), so a
 * member's balance is everything earned minus what they've spent. Spending is
 * held as soon as it's requested and refunded if a parent declines.
 */

import { v4 as uuidv4 } from "uuid"
import { getDb } from "../db"

/** Record a chore being checked off (done) or unticked, for the member it's assigned to. */
export function recordCompletion(
  householdId: string,
  chore: { id: string; title: string; points: number; memberId: string | null },
  done: boolean,
  date: string,
): void {
  const db = getDb()
  if (done) {
    if (!chore.memberId) return
    db.prepare(
      "INSERT INTO chore_completions (id, household_id, chore_id, member_id, title, points, date) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(uuidv4(), householdId, chore.id, chore.memberId, chore.title, chore.points, date)
  } else {
    db.prepare(
      `DELETE FROM chore_completions WHERE id = (
         SELECT id FROM chore_completions WHERE household_id = ? AND chore_id = ? ORDER BY created_at DESC LIMIT 1)`,
    ).run(householdId, chore.id)
  }
}

export type MemberPoints = {
  memberId: string
  /** Earned minus requested or approved spending. */
  balance: number
  earnedToday: number
  earnedThisWeek: number
  /** Days in a row, up to today (or yesterday, if today isn't done yet), with a chore checked off. */
  streak: number
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function memberPoints(householdId: string, today: string): MemberPoints[] {
  const db = getDb()
  const away = db.prepare("SELECT away_from, away_until FROM households WHERE id = ?").get(householdId) as
    | { away_from: string | null; away_until: string | null }
    | undefined
  const wasAway = (day: string) => !!away?.away_from && !!away.away_until && day >= away.away_from && day <= away.away_until
  const members = db.prepare("SELECT id FROM members WHERE household_id = ?").all(householdId) as { id: string }[]
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00`).getDay() + 6) % 7)) // Monday
  return members.map(({ id }) => {
    const earned = db.prepare("SELECT COALESCE(SUM(points), 0) AS n FROM chore_completions WHERE household_id = ? AND member_id = ?")
      .get(householdId, id) as { n: number }
    const spent = db.prepare(
      "SELECT COALESCE(SUM(cost), 0) AS n FROM redemptions WHERE household_id = ? AND member_id = ? AND status != 'declined'",
    ).get(householdId, id) as { n: number }
    const sumSince = (from: string) => (db.prepare(
      "SELECT COALESCE(SUM(points), 0) AS n FROM chore_completions WHERE household_id = ? AND member_id = ? AND date >= ? AND date <= ?",
    ).get(householdId, id, from, today) as { n: number }).n
    const days = new Set((db.prepare(
      "SELECT DISTINCT date FROM chore_completions WHERE household_id = ? AND member_id = ? AND date <= ? ORDER BY date DESC LIMIT 400",
    ).all(householdId, id, today) as { date: string }[]).map((r) => r.date))
    let day = days.has(today) ? today : addDays(today, -1)
    let streak = 0
    // Days away neither count nor break the streak.
    for (let guard = 0; guard < 800 && (days.has(day) || wasAway(day)); guard++) {
      if (days.has(day)) streak++
      day = addDays(day, -1)
    }
    return { memberId: id, balance: earned.n - spent.n, earnedToday: sumSince(today), earnedThisWeek: sumSince(weekStart), streak }
  })
}
