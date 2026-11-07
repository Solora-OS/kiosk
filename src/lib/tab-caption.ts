import { useStore, type TabKey } from "./store"
import { useAway, isAwayOn } from "./away"
import { useSummer } from "./summer"
import { homeTodayISO } from "./home-time"
import { choreDone, choreDueOn, expandEventsOn, pausesWhileAway } from "./data"

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/**
 * The line above each page title: always a live count of what's on that page,
 * worked out the same way the page itself counts it. The phone's header does
 * the same, so the wall and the phone say the same thing.
 */
export function useTabCaption(tab: TabKey): string {
  const { events, chores, lists, meals, photos, members, activeMember } = useStore()
  const away = useAway()
  const summer = useSummer()
  const iso = homeTodayISO()
  const today = new Date(`${iso}T00:00:00`)

  const eventsToday = expandEventsOn(events, iso).length
  const paused = isAwayOn(away, iso)
  const due = chores
    .filter((c) => (activeMember ? c.memberId === activeMember : true))
    .filter((c) => choreDueOn(c, today, summer) && !(paused && pausesWhileAway(c)))
  const left = due.filter((c) => !choreDone(c, iso)).length
  const dateLine = today.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })

  switch (tab) {
    case "home":
      return `${dateLine} · ${eventsToday + left ? `${count(eventsToday + left, "thing")} today` : "nothing else on today"}`
    case "calendar":
      return eventsToday ? `${count(eventsToday, "event")} today` : "Nothing on today"
    case "chores":
    case "rewards":
      return due.length ? `${due.length - left} of ${due.length} done today` : "Nothing due today"
    case "lists": {
      const open = lists.reduce((n, l) => n + l.items.filter((i) => !i.done).length, 0)
      return `${count(lists.length, "list")} · ${open} left`
    }
    case "meals": {
      const days = new Set(meals.filter((m) => !m.date && /dinner/i.test(m.type)).map((m) => m.day)).size
      return `${days} of 7 dinners planned`
    }
    case "photos":
      return count(photos.length, "photo")
    case "settings":
      return count(members.filter((m) => m.id !== "family").length, "person", "people")
  }
}
