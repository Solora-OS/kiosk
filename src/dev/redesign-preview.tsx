/**
 * Throwaway preview harness for the redesign: runs the real kiosk app against
 * a fake hub (patched fetch) with in-memory storage, so it never touches a
 * real hub or another tab's saved state. Open /redesign-preview.html?theme=dark.
 */

const mem = new Map<string, string>()
const q = new URLSearchParams(location.search)
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d) }
const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, "")
const jwt = `${b64({ alg: "none" })}.${b64({ sub: "dev-kitchen" })}.sig`

mem.set("solora-theme", q.get("theme") ?? "light")
mem.set("solora.kiosk.deviceToken", jwt)
mem.set("solora.token", jwt)
mem.set("solora.kiosk.deviceState", JSON.stringify({ setupComplete: true, language: "en-US", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, deviceName: "Kitchen", orientation: "normal", slideshowIdleMins: null }))
if (q.get("tab")) mem.set("solora.kiosk.tab", q.get("tab")!)
Object.defineProperty(window, "localStorage", {
  value: {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  },
})
if (q.get("theme") === "dark") document.documentElement.classList.add("dark")

const wd = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][(d.getDay() + 6) % 7] }
const h = new Date().getHours()
const members = [
  { id: "m-mom", name: "Mom", color: "coral", role: "parent" },
  { id: "m-dad", name: "Dad", color: "blue", role: "parent" },
  { id: "m-ava", name: "Ava", color: "green", role: "kid" },
  { id: "m-leo", name: "Leo", color: "amber", role: "kid" },
]
const calendars = [
  { id: "c-fam", name: "Family", color: "blue", member_ids: [] },
  { id: "c-kids", name: "Kids", color: "green", member_ids: [] },
  { id: "c-hol", name: "Holidays", color: "teal", member_ids: [] },
]
const ev = (id: string, title: string, date: string, start: number, end: number, cal: string, who: string[], extra = {}) =>
  ({ id, title, date, start_hour: start, end_hour: end, calendar_id: cal, member_ids: who, time: "", ...extra })
const events = [
  ev("e1", "Dentist", day(0), Math.max(0, h - 0.5), Math.min(23.75, h + 0.75), "c-fam", ["m-leo", "m-mom"], { location: "Dr. Patel, Main St" }),
  ev("e2", "Grocery run", day(0), Math.min(23, h + 2), Math.min(23.5, h + 3), "c-fam", ["m-mom"]),
  ev("e3", "Soccer practice", day(0), Math.min(23, h + 5), Math.min(23.75, h + 6.5), "c-kids", ["m-ava", "m-dad"], { repeat_days: [2, 4, 6] }),
  ev("e4", "Brunch at Nana's", day(1), 11, 13, "c-fam", ["m-mom", "m-dad", "m-ava", "m-leo"]),
  ev("e5", "Piano", day(2), 15.5, 16.5, "c-kids", ["m-ava"]),
  ev("e6", "No school", day(4), 0, 24, "c-kids", ["m-ava", "m-leo"], { all_day: true }),
  ev("e7", "Library pickup", day(5), 18, 18.5, "c-kids", ["m-ava"]),
  ev("e8", "Thanksgiving", day(19), 0, 24, "c-hol", [], { all_day: true, countdown: true }),
  ev("e9", "Leo's birthday", day(41), 0, 24, "c-fam", ["m-leo"], { all_day: true, countdown: true }),
  ev("e10", "Book club", day(0), 19.5, 21, "c-fam", ["m-mom"]),
]
const all = [0, 1, 2, 3, 4, 5, 6]
const chores = [
  { id: "k1", title: "Water plants", member_id: "m-mom", points: 5, repeat_days: all, icon: "plant", done_on: day(0) },
  { id: "k2", title: "Fold laundry", member_id: "m-mom", points: 10, repeat_days: all, icon: "laundry" },
  { id: "k3", title: "Take out trash", member_id: "m-dad", points: 10, repeat_days: all, icon: "trash" },
  { id: "k4", title: "Make your bed", member_id: "m-ava", points: 5, repeat_days: all, icon: "bed", done_on: day(0) },
  { id: "k5", title: "Feed Biscuit", member_id: "m-ava", points: 5, repeat_days: all, icon: "dog" },
  { id: "k6", title: "Read 20 minutes", member_id: "m-ava", points: 10, repeat_days: all, icon: "book" },
  { id: "k7", title: "Make your bed", member_id: "m-leo", points: 5, repeat_days: all, icon: "bed" },
  { id: "k8", title: "Clear the table", member_id: "m-leo", points: 10, repeat_days: all, icon: "dishes" },
]
const lists = [
  { id: "l1", title: "Groceries", color: "coral", items: ["Milk", "Tortillas", "Avocados", "Shredded cheese", "Limes", "Apple juice", "Dog food"].map((label, i) => ({ id: `g${i}`, label, done: false })).concat(["Eggs", "Bread", "Bananas"].map((label, i) => ({ id: `gd${i}`, label, done: true }))) },
  { id: "l2", title: "Packing for Nana's", color: "green", items: [{ id: "p1", label: "Soccer cleats", done: false }, { id: "p2", label: "Toothbrushes", done: false }] },
  { id: "l3", title: "Hardware store", color: "blue", items: [{ id: "h1", label: "Light bulbs", done: false }] },
  { id: "l4", title: "Movies to watch", color: "pink", items: [{ id: "v1", label: "Paddington", done: true }] },
]
const meals = [
  { id: "ml1", day: wd(0), type: "Dinner", name: "Tacos", member_id: "m-dad", ingredients: ["Tortillas", "Limes"] },
  { id: "ml2", day: wd(0), type: "Breakfast", name: "Pancakes", member_id: "m-ava" },
  { id: "ml3", day: wd(2), type: "Dinner", name: "Sheet-pan chicken", member_id: "m-mom" },
  { id: "ml4", day: wd(3), type: "Dinner", name: "Spaghetti night", member_id: "m-dad" },
  { id: "ml5", day: wd(5), type: "Dinner", name: "Soup & grilled cheese", member_id: "m-mom" },
  { id: "ml6", day: wd(1), type: "Lunch", name: "Brunch at Nana's", member_id: "" },
]
const notifications = [
  { id: "n1", title: "Ava wants Movie night pick", body: "200 points · waiting for a grown-up", time: "2m", member_id: "m-ava" },
  { id: "n2", title: "Mom added 3 to Groceries", body: "Limes, tortillas, cheese", time: "18m", member_id: "m-mom" },
]
const rewards = {
  rewards: [
    { id: "r1", title: "Movie night pick", cost: 200 },
    { id: "r2", title: "Ice cream trip", cost: 150 },
    { id: "r3", title: "30 min late bedtime", cost: 80 },
    { id: "r4", title: "New LEGO set", cost: 600 },
  ],
  points: [
    { memberId: "m-mom", balance: 120, streak: 3 },
    { memberId: "m-dad", balance: 85, streak: 0 },
    { memberId: "m-ava", balance: 240, streak: 12 },
    { memberId: "m-leo", balance: 60, streak: 2 },
  ],
  redemptions: [{ id: "x1", rewardId: "r1", title: "Movie night pick", cost: 200, memberId: "m-ava", status: "requested" }],
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
const realFetch = window.fetch.bind(window)
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
  if (!url.includes("/api/v1/")) {
    if (url.startsWith("http") && !url.startsWith(location.origin)) return json({})
    return realFetch(input, init)
  }
  const path = url.split("/api/v1")[1].split("?")[0]
  if (path.startsWith("/kiosk/state")) return json({ found: true, device_id: "dev-kitchen", device_name: "Kitchen", paired: true, household_id: "h1", household_name: "The Rivera household", on_hub: true, setup_complete: true, language: "en-US" })
  if (path.startsWith("/kiosk/register")) return json({ device_token: jwt })
  if (path.startsWith("/snapshot")) return json({ members, calendars, events, chores, lists, meals, notifications, photos: [] })
  if (path.startsWith("/rewards")) return json(rewards)
  if (path.startsWith("/home-layout") || path.startsWith("/home/layout")) return json(null)
  if (path.startsWith("/away")) return json(null)
  if (path.startsWith("/hub/info")) return json({ hub_id: "hub1", name: "Rivera hub", claimed: true })
  return json({})
}

void import("../main")
