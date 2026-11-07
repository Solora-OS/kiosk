// The hub's contract: the family story played against a real hub and central.
//   npm run test:contract                     # Node hub
//   UPDATE_SNAPSHOTS=1 npm run test:contract  # accept new responses
//   KEEP_CONTRACT_DIR=1 npm run test:contract # keep logs and data
//   HUB_BIN=../src-tauri/target/debug/solora-hub npm run test:contract   # the Rust hub
//   CONTRACT_CHAPTERS=01,02 npm run test:contract                        # only those chapters
// Areas run in order and share state (harness.ctx): each chapter builds on
// the household the earlier ones made, so a chapter needs the ones before it.
import { before, after } from "node:test"
import { boot, shutdown } from "./harness.mjs"

before(boot, { timeout: 180_000 })
after(shutdown)

const CHAPTERS = [
  "01-unboxing.mjs",
  "01b-central-link.mjs",
  "02-family.mjs",
  "03-household.mjs",
  "04-files-calendars.mjs",
  "05-central.mjs",
  "06-new-hub.mjs",
  "07-live-events.mjs",
  "08-delete-account.mjs",
]
const only = process.env.CONTRACT_CHAPTERS?.split(",").map((c) => c.trim().padStart(2, "0"))
const picked = CHAPTERS.filter((c) => !only || only.includes(c.slice(0, 2)))
// With no tests node:test never runs `after`, which would leave the servers up.
if (picked.length === 0) throw new Error(`CONTRACT_CHAPTERS=${process.env.CONTRACT_CHAPTERS} matches no chapter`)
for (const chapter of picked) await import(`./areas/${chapter}`)
