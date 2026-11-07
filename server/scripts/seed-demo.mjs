#!/usr/bin/env node
// seed-demo.mjs — fills an unclaimed hub with a made-up family for app store
// review, plus one standing invite code per reviewer (invites.reusable): the
// reviewer signs in with their own account, enters the code once per device,
// and lands in the household from anywhere, through central's relay.
//
//   node scripts/seed-demo.mjs [--db ~/.solora/solora.db] [--seed 42] "App Review (Apple)" "App Review (Android)"
//   node scripts/seed-demo.mjs --recode     new codes for the standing invites, family kept
//   node scripts/seed-demo.mjs --shared     one open code for closed testers (invites.shared), family kept
//
// Run it with the hub stopped, then start the hub: it registers the codes
// with central at boot. Prints the codes. Refuses a hub that already has a household.
import Database from "better-sqlite3"
import crypto from "node:crypto"
import os from "node:os"
import path from "node:path"

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const [value] = args.splice(i, 2).slice(1)
  return value
}
const dbPath = opt("--db", path.join(os.homedir(), ".solora", "solora.db"))
let seed = Number(opt("--seed", crypto.randomInt(1, 2 ** 31)))
const recode = args.includes("--recode")
if (recode) args.splice(args.indexOf("--recode"), 1)
const sharedCode = args.includes("--shared")
if (sharedCode) args.splice(args.indexOf("--shared"), 1)
const reviewers = args.length ? args : ["App Review (Apple)", "App Review (Android)"]

// Small seeded PRNG (mulberry32) so a family can be made again with --seed.
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)]
const some = (xs, n) => [...xs].sort(() => rand() - 0.5).slice(0, n)
const id = () => crypto.randomUUID()
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
// Same shape as the hub's own codes (routes/invites.ts inviteCode): the app only
// fixes up a typed code without its dash when it's this "K3F-9Q2" shape.
const code = () => Array.from({ length: 6 }, (_, i) => (i === 3 ? "-" : "") + CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("")

const iso = (d) => d.toISOString().slice(0, 10)
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, 12)
const today = addDays(new Date(), 0)
const hhmm = (h) => `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`

const db = new Database(dbPath)
db.pragma("foreign_keys = ON")
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'households'").get()) {
  console.error(`${dbPath} has no hub tables yet. Start the hub once (it creates them), stop it, then seed.`)
  process.exit(1)
}
const insert = (table, row) => {
  const cols = Object.keys(row)
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row))
}
if (recode) {
  const rows = db.prepare("SELECT id, name FROM invites WHERE reusable = 1 AND shared = 0 ORDER BY name").all()
  for (const r of rows) {
    const c = code()
    db.prepare("UPDATE invites SET code = ? WHERE id = ?").run(c, r.id)
    console.log(`  ${r.name}: ${c}`)
  }
  if (!rows.length) console.error("No standing invites to recode.")
  db.close()
  process.exit(0)
}
if (sharedCode) {
  // Each tester who enters it gets their own member slot (routes/invites.ts claim).
  const existingShared = db.prepare("SELECT code FROM invites WHERE shared = 1").get()
  if (existingShared) {
    console.log(`  Testers: ${existingShared.code}`)
  } else {
    const anchor = db.prepare("SELECT id, household_id FROM members ORDER BY created_at LIMIT 1").get()
    if (!anchor) {
      console.error("No family to add testers to. Seed the hub first.")
      process.exit(1)
    }
    const c = code()
    insert("invites", {
      id: id(), household_id: anchor.household_id, member_id: anchor.id, token: crypto.randomBytes(24).toString("base64url"), code: c,
      name: "Testers", role: "adult", color: "teal", expires_at: "2099-12-31T00:00:00.000Z", reusable: 1, shared: 1,
    })
    console.log(`  Testers: ${c}`)
  }
  db.close()
  process.exit(0)
}
const { n } = db.prepare("SELECT COUNT(*) AS n FROM households").get()
if (n > 0) {
  console.error(`${dbPath} already has a household. Seed a fresh hub.`)
  process.exit(1)
}

const surname = pick(["Rivera", "Okafor", "Lindqvist", "Patel", "Moreau", "Tanaka", "Brennan", "Haddad"])
const household = { id: id(), name: `The ${surname} Family` }
const ALL = JSON.stringify(["calendar", "chores", "lists", "meals", "members", "hub"])
const people = [
  { name: pick(["Alex", "Sam", "Jordan", "Priya"]), role: "admin", color: "blue", dob: "1985-03-14", perms: ALL },
  { name: pick(["Chris", "Dana", "Morgan", "Ravi"]), role: "adult", color: "green", dob: "1987-09-02", perms: ALL },
  { name: pick(["Mia", "Ava", "Zoe", "Nora"]), role: "teen", color: "purple", dob: "2011-06-21", perms: JSON.stringify(["lists"]) },
  { name: pick(["Leo", "Max", "Theo", "Eli"]), role: "child", color: "orange", dob: "2018-11-05", perms: "[]" },
].map((p) => ({ ...p, id: id() }))
const [parent1, parent2, teen, kid] = people


const codes = []
db.transaction(() => {
  insert("households", { id: household.id, name: household.name })
  for (const p of people) {
    insert("members", { id: p.id, household_id: household.id, name: p.name, initial: p.name[0], color: p.color, role: p.role, dob: p.dob, permissions: p.perms, pending: 0 })
  }

  // Reviewers join as adults who can use everything except managing the hub,
  // so a reviewer can't hand the household off or wipe it.
  const reviewerPerms = JSON.stringify(["calendar", "chores", "lists", "meals", "members"])
  for (const [i, name] of reviewers.entries()) {
    const memberId = id()
    const color = ["teal", "pink", "yellow"][i % 3]
    insert("members", { id: memberId, household_id: household.id, name, initial: name[0], color, role: "adult", permissions: reviewerPerms, pending: 1 })
    const c = code()
    insert("invites", {
      id: id(), household_id: household.id, member_id: memberId, token: crypto.randomBytes(24).toString("base64url"), code: c,
      name, role: "adult", color, expires_at: "2099-12-31T00:00:00.000Z", reusable: 1,
    })
    codes.push({ name, code: c })
  }

  // Calendar: a regular week plus a few one-offs over the next three weeks.
  const weekly = [
    { title: `${kid.name}'s swim lesson`, days: "2", start: 16.5, who: [kid, parent2], loc: "Community pool" },
    { title: `${teen.name}'s soccer practice`, days: "1,3", start: 17, who: [teen], loc: "Riverside fields" },
    { title: "Family movie night", days: "5", start: 19, who: people },
    { title: "Piano", days: "4", start: 15.5, who: [teen], loc: "Ms. Hale's studio" },
  ]
  for (const e of weekly) {
    insert("events", {
      id: id(), household_id: household.id, title: e.title, date: iso(addDays(today, -14)), repeat_days: e.days,
      time: hhmm(e.start), start_hour: e.start, end_hour: e.start + 1, member_ids: JSON.stringify(e.who.map((p) => p.id)), location: e.loc ?? null, remind_minutes: 30,
    })
  }
  const oneOffs = [
    ["Dentist", [kid, parent1], "Bright Smiles Dental"], ["Parent-teacher conference", [parent1, parent2], "Oakwood Elementary"],
    ["Grandma's birthday dinner", people, "Grandma's house"], ["Science fair", [teen, parent2], "Oakwood Middle School"],
    ["Car service", [parent1], "Main St Garage"], ["Playdate at the park", [kid], "Maple Park"], ["Book club", [parent2], null],
    ["Haircuts", [kid, teen], "Shear Joy"],
  ]
  for (const [title, who, loc] of some(oneOffs, 7)) {
    const start = pick([9, 10, 11, 13.5, 15, 16, 18])
    insert("events", {
      id: id(), household_id: household.id, title, date: iso(addDays(today, Math.floor(rand() * 21) - 2)),
      time: hhmm(start), start_hour: start, end_hour: start + 1, member_ids: JSON.stringify(who.map((p) => p.id)), location: loc,
    })
  }
  insert("events", { id: id(), household_id: household.id, title: "Summer vacation", date: iso(addDays(today, 40)), end_date: iso(addDays(today, 47)), all_day: 1, countdown: 1, member_ids: JSON.stringify(people.map((p) => p.id)) })

  // Chores with points, some done today.
  const chores = [
    [kid, "Make your bed", "bed", "0,1,2,3,4,5,6", 2], [kid, "Feed the cat", "cat", "0,1,2,3,4,5,6", 3], [kid, "Put toys away", "toys", "1,3,5", 2],
    [teen, "Empty the dishwasher", "dishes", "1,2,3,4,5", 5], [teen, "Take out the trash", "trash", "2,5", 5], [teen, "Laundry", "laundry", "6", 8],
    [parent2, "Recycling out", "recycling", "4", 0], [parent1, "Water the plants", null, "0,3", 0],
  ]
  for (const [who, title, icon, days, points] of chores) {
    const done = rand() < 0.35
    insert("chores", { id: id(), household_id: household.id, member_id: who.id, title, icon, repeat_days: days, points, done: done ? 1 : 0, done_on: done ? iso(today) : null })
  }
  for (const [title, cost, icon] of [["Extra screen time", 20, null], ["Pick tonight's dessert", 15, null], ["Stay up 30 minutes late", 30, null], ["Trip to the ice cream shop", 60, null]]) {
    insert("rewards", { id: id(), household_id: household.id, title, cost, icon })
  }

  // Lists.
  const lists = [
    ["Groceries", "green", ["Milk", "Eggs", "Bananas", "Bread", "Pasta", "Spinach", "Cheddar", "Coffee", "Apples", "Yogurt"]],
    ["Weekend to-do", "blue", ["Fix the bike tire", "Return library books", "Buy birthday card", "Clean out the garage"]],
    ["Packing for vacation", "orange", ["Sunscreen", "Swimsuits", "Chargers", "Snacks for the drive"]],
  ]
  for (const [title, color, items] of lists) {
    const listId = id()
    insert("lists", { id: listId, household_id: household.id, title, color })
    some(items, Math.max(3, items.length - 2)).forEach((label, position) =>
      insert("list_items", { id: id(), list_id: listId, label, position, done: rand() < 0.2 ? 1 : 0, added_by: pick(people).id }))
  }

  // A week of dinners.
  const dinners = [
    ["Spaghetti bolognese", ["Spaghetti", "Ground beef", "Tomato sauce"]], ["Chicken tacos", ["Tortillas", "Chicken", "Salsa", "Avocado"]],
    ["Veggie stir-fry", ["Rice", "Broccoli", "Peppers", "Soy sauce"]], ["Homemade pizza", ["Pizza dough", "Mozzarella", "Basil"]],
    ["Salmon and potatoes", ["Salmon", "Potatoes", "Lemon"]], ["Pancakes for dinner", ["Flour", "Eggs", "Maple syrup"]],
    ["Chili", ["Beans", "Ground beef", "Onion"]], ["Mac and cheese", ["Macaroni", "Cheddar"]],
  ]
  const meals = some(dinners, 7)
  for (const [i, day] of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].entries()) {
    const [name, ingredients] = meals[i]
    insert("meals", { id: id(), household_id: household.id, member_id: pick([parent1, parent2]).id, day, name, type: "dinner", ingredients: JSON.stringify(ingredients) })
  }
})()
db.close()

console.log(`Seeded ${household.name} into ${dbPath}`)
for (const c of codes) console.log(`  ${c.name}: ${c.code}`)
