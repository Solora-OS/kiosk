# Hub server → Rust — port plan

Moves the household hub (`kiosk/server`, Node + Express + Socket.IO +
better-sqlite3) into the kiosk app itself, in Rust, so the wall panel runs
everything on its own: Android has no Node, and the Linux build stops needing
a second service. Phones, the kiosk web UI and central must not notice: same
URLs, JSON, status codes, error text, socket events, tokens and database file.

## Where things stand today

| Area | Today (`kiosk/server`) | On the panel |
|---|---|---|
| Size | ~8,200 lines TS: 25 route files (~120 endpoints), 9 services, 11 libs | — |
| HTTP | Express on `0.0.0.0:4000`, `/api/v1/*`, `/photo-files`, CORS, rate limits | Must keep port 4000: phones and the kiosk web view call it |
| Realtime | Socket.IO server, JWT auth, room `household:<id>`, `broadcast()` after every write | `mobile/src/lib/socket.ts`, `kiosk/src/lib/local-api.ts` use socket.io-client 4 |
| Database | better-sqlite3, `scripts/schema.sql` (24 tables), 275 prepared statements, `~/.lumora/lumora.db` | No native Node addons on Android |
| Identity | `~/.lumora/.secret` (HS256 JWT key), `hub-identity.json`, `central.json` (hub id/token, per-kiosk central JWTs), `invite-ecdh.key` | Must carry over so existing phones stay signed in |
| Crypto | bcryptjs, jsonwebtoken, AES-256-GCM (`token-crypto`, `remote-rpc`, `hub-transfer`, `invite-relay`), P-256 ECDH + HKDF (`invite-relay`) | — |
| Central link | REST register/login (`central-registry.ts`), socket.io-client to central: heartbeat, `hub:relay`, `hub:rpc`, `hub:invite-rpc`, `support:request`, `manufacturer:action` | — |
| Discovery | bonjour-service advertises `_lumora._tcp` | Android needs a Wi-Fi multicast lock |
| Background work | reminders, calendar sync (iCal + Google/Microsoft OAuth) on timers | Must keep running while the screen sleeps |
| Tests | None for the hub; `FAMILY_SIMULATION_REPORT.md` was a one-off scripted run (131 calls) | — |

(Before the port. Now the hub runs inside the app everywhere; see Phase 7.)

## Approach

**Rust, inside the Tauri app, as its own crate.** `kiosk/src-tauri/hub/`
(`solora-hub`) is a library the app starts on a background Tokio runtime, and
also a small binary (`cargo run -p solora-hub`) so it runs on a Mac against
the same tests as the Node hub.

| Node piece | Rust | Why |
|---|---|---|
| Express | `axum` + `tower-http` (CORS, limits) | Same routes, middleware style |
| Socket.IO server | `socketioxide` | Speaks the socket.io v4 protocol the clients use |
| socket.io-client (to central) | `rust_socketio` (async) | Central stays Node |
| better-sqlite3 | `rusqlite` (`bundled`) | Same SQLite, same `schema.sql`, same `lumora.db` file |
| jsonwebtoken | `jsonwebtoken` (HS256) | Same `.secret` → existing tokens stay valid |
| bcryptjs | `bcrypt` | Reads/writes the same `$2a$`/`$2b$` hashes |
| crypto (GCM, ECDH, HKDF) | `aes-gcm`, `p256`, `hkdf`, `sha2` | Byte-for-byte with Node's output |
| bonjour-service | `mdns-sd` + Kotlin `MulticastLock` | Pure Rust; Android only needs the lock |
| fetch (central, iCal, OAuth) | `reqwest` (rustls) | Already in the app via tauri-plugin-http |
| multer | axum `Multipart` | Photos |
| setInterval jobs | `tokio::time` tasks | Reminders, calendar sync |

Rejected: **nodejs-mobile** (Node 18 only; `engines` wants ≥20; better-sqlite3
needs a cross-compiled addon; a second runtime to keep alive and update) and
**rewriting the clients** (phones in the field speak today's protocol).

## Rules for the port

1. **The contract is the spec.** Every endpoint keeps its path, method, request
   and response JSON (field names, nulls, ordering of lists), status codes and
   error `message` strings. Socket events keep names and payloads.
2. **Same files, same formats.** Rust reads the existing `lumora.db`,
   `.secret`, `hub-identity.json`, `central.json`, `invite-ecdh.key`, photo
   files. Moving a hub from Node to Rust is copying a folder.
3. **Black-box tests first, against Node.** Nothing is ported until the
   contract suite (Phase 0) passes on the Node hub; each phase is done when it
   passes on Rust too.
4. **One phase at a time behind a switch.** Until cutover, the Linux build keeps
   running Node; Android uses the Rust hub as soon as Phase 2 lands. (Cut over
   in Phase 7.)

## Phase 0 — contract suite (against the Node hub) — done 2026-11-04

`kiosk/server/tests/contract/` (see its README): 37 tests, 336 snapshots, all
121 route handlers, 28 kinds of live event; stable over repeated runs, ~15 s.
Gaps it lists: real OAuth, the reminder/sync timers, kiosk auto-login with its
file, mDNS discovery during a transfer, legacy-user claims.

What was planned:

`kiosk/server/tests/contract/*.test.mjs`, `node --test`, pointed at a hub by
`HUB_URL` (+ a throwaway central, like `central/tests/e2e.test.mjs`):

1. Turn the family simulation into tests: unboxing, setup code (loopback vs LAN
   `403`), first claim, the four invite paths, device-only refresh, remote
   invite relay, every CRUD area, photos, ICS feed, transfer, support.
2. A socket probe that records which events each write broadcasts.
3. Normalise ids/timestamps, then snapshot responses (`--update` to refresh).
4. Run it in a fresh `$HOME` so it never touches `~/.lumora`.

Done when: the suite passes against `npm run dev` and covers all 25 route files
(calendar-provider OAuth callbacks are stubbed, as in the simulation).

## Phase 1 — skeleton that boots and pairs — done 2026-11-04

`kiosk/src-tauri/hub` (`solora-hub`, a workspace member of the app): storage,
device and account tokens, the `requireAuth` rules, hub / kiosk / auth routes,
`/health`, `/central-identity`, `/connection-health`, the Socket.IO server with
household rooms, central registration (same `central.json`), and the live
link to central with heartbeats and `hub:relay`. Contract chapter 1 passes:
`HUB_BIN=../src-tauri/target/debug/solora-hub CONTRACT_CHAPTERS=01 npm run test:contract`.
The Node and Rust hubs swap on one data folder and accept each other's tokens.
The central socket client is a small one of our own (`socketio_client.rs`):
rust_socketio needs OpenSSL, which doesn't build for Android; the crate now
cross-compiles for `aarch64-linux-android`. Not done yet, moved to Phase 3:
booting it inside the emulator app, since the wall's start-up needs the
household routes (members, snapshot) to reach the Home screen.

What was planned:

- Crate, config (port, data dir: `~/.lumora` on Linux/Mac, app data dir on
  Android), schema apply, secret/identity files.
- JWT + auth middleware (`requireAuth`, roles, `memberStillLinked`), rate limits, CORS.
- Socket.IO with `socketAuth`, rooms, `broadcast()`.
- `hub` (`/info`, `/setup` with the loopback rule), `kiosk` (register, state,
  heartbeat, setup, claim, devices), `auth` (session, refresh), health.

Done when: the emulator boots the Rust hub in-app and gets through setup to the
Home screen with no Mac hub.

## Phase 2 — central link — done 2026-11-04

`relay.rs` (`hub:rpc` with the same allowlist; `hub:invite-rpc` with the
hub's P-256 invite key, and registering/unregistering invites at central),
`support.rs` (Solora's actions into the activity log, deduplicated; support
requests notifying admins; catching up on reconnect; the five
`/api/v1/support` routes), `household.rs` (`writeLog`, `logActivity`,
`notifyMembers`, `callerMember`, `manages`). New contract chapter **01b**
covers what needs only chapter 1's household: the relay (session, blocked
paths, wrong key), support permissions, a request reaching the admin and
denied, a Solora action in the log. The Rust hub passes chapters 01 + 01b
(12/12); the Node hub the whole suite (41/41). Still to be proven by the
contract once their routes exist (Phase 3): invites through central (chapter
2; the ECDH/HKDF key is checked against Node-generated vectors now), a lost
display (chapter 5). Catching up on Solora's actions after a reconnect isn't
covered by a test.

What was planned:

`central-registry` (register, login, `central.json`, per-kiosk tokens,
`request-central-token`), central socket client (heartbeat, `hub:relay`,
`hub:rpc` with `remote-rpc` AES-GCM, `hub:invite-rpc`, `support:request`,
`manufacturer:action`), `invite-relay` (ECDH/HKDF).

Done when: the kiosk's central token, OTA check, lock, remote commands and the
off-network (grandma) invite work against the real central.

## Phase 3 — household data — done 2026-11-04

members, invites (tap tickets, account and device-only claims, registered
with central), calendars, events, chores, points, rewards, lists, meals,
notifications, home, away, summer, seasons, wall (presence pass, near, throw),
hub commands and display state, snapshot, activity log; `db.rs` reads rows
and binds values like better-sqlite3, `hometime.rs` is the home time zone.
Two Node behaviours that mattered: a database error answers 500 (`try_run!`),
and events go out before the route answers. The Rust hub passes contract
chapters 01–03 (30/30, repeatedly) and, of the whole suite, 34/41: chapter 5
(relay, support, lost display) included; what fails is Phase 4 (photos, iCal,
calendar links, providers), Phase 5 (transfer) and chapter 7 (needs photos).

**The hub runs inside the Android app** (`src/hub.rs`, port 4000, data in the
app's data dir under `hub/`, central from `SOLORA_HUB_CENTRAL_URL` at build
time, default the kiosk's central). On the emulator the wall boots into the
unboxing screen ("Start your family", setup code and QR) from it, with nothing
running on the Mac. Not there yet on Android: LAN advertising (mDNS, Phase 6),
staying up while the screen sleeps (Phase 6).

What was planned:

members, invites, calendars, events, chores, lists, meals, rewards + points,
notifications, snapshot, activity-logs, home, away, seasons, summer, wall —
the bulk of the 275 statements, mostly mechanical once Phase 1's helpers exist.

## Phase 4 — files and calendars — done 2026-11-04

photos (multipart with the same image filter, base64, chunks, `/photo-files`
with header or `?token=`), the family's iCal feed and its link, calendar links
(the iCal parser: folding, quoted params, escapes, TZIDs, floating times,
durations, moved/cancelled occurrences; weekly/daily repeats kept, monthly
"nth weekday", yearly and every-other-week written out; hourly re-read), and
Google/Microsoft (token exchange, tokens stored AES-GCM like Node, browse
routes, mappings, exclusions, the hourly 90-day sync). The Rust hub passes the
whole suite except chapter 6 (transfer, Phase 5): 39/41, repeatedly.
Still untested against real providers (no credentials), as in Node.

What was planned:

photos (multipart upload, `/photo-files`), `ics` + `ics-link`,
`calendar-links`, `calendar-sync` (iCal fetch/parse, recurrence), and
`calendar-providers` (Google/Microsoft OAuth; needs real test credentials to
exercise).

## Phase 5 — the rest — done 2026-11-04

Hub transfer (`routes/transfer.rs`: one open move, the XXXX-XXXX code, 10
wrong tries cancel it, scrypt + AES-GCM sealing byte-compatible with Node,
calendar tokens re-encrypted with the new hub's secret, `INSERT OR REPLACE`
over the columns this schema has, unpaired displays join the household, and
mDNS `_lumora._tcp` discovery when no address is given) and the event
reminders tick (`reminders.rs`, every minute, `reminders_sent` dedupe).
Support, hub commands and `notify` came over in Phases 2–3.

The Rust hub passes the whole suite, 41/41: 38 clean runs in a row. The very
first run of the finished port failed 5 of 41, and that log wasn't kept; it
hasn't happened again since (the loop keeps a failing run's log). Reminders aren't in
the suite (they depend on the clock): the same seeded events (timed, all-day,
repeating, skipped, too late, a week ahead, listed members) produce identical
notifications from Node's `runReminders` and the Rust tick, and a restart sends
nothing twice. Not exercised: mDNS discovery during a pull (the suite passes
`from`), which needs two hubs on one Wi-Fi.

## Phase 6 — platform glue — done 2026-11-04

- **mDNS** (`hub/src/mdns.rs`): `_lumora._tcp` with the same TXT records as
  Node (hub_id, name, claimed; re-published when claimed changes). The instance
  name adds the start of the hub id ("Solora Hub F29F") so two hubs on one
  Wi-Fi, as in a move, don't answer for each other. Seen by macOS `dns-sd`.
- **Android:** `SoloraHubService.kt`, a foreground service (special use)
  started by `MainActivity`, holds a partial wake lock, a Wi-Fi lock and the
  multicast lock. On the emulator the hub answered over the emulator's network
  with the screen off and in forced deep Doze. No battery-optimisation
  exemption: there's no device-owner API for it on Android 12, and Doze doesn't
  run while the panel is on mains. The emulator's hub shows up in the Mac's
  `dns-sd -B _lumora._tcp`. Not checked: a real phone finding the panel, and
  calls out to central in Doze.
- **Linux:** the app starts the same hub (`src/hub.rs`) on `~/.lumora`, the
  Node hub's folder, with the Node hub's variables, so an existing Linux hub
  carries on as it was. `SOLORA_HUB=off` leaves it to a separate server.
  On the dev VM the app's hub serves on port 4000 and advertises; with no
  address given it found a claimed hub on the Mac over mDNS and pulled its
  family across machines.
  `os/provision.sh` never installed the Node hub, so nothing to remove there.
  `os/tools/build-kiosk.sh` now also uploads `server/scripts/schema.sql`
  (the hub embeds it); the VM builds offline from a vendored crate folder,
  which needs a fresh `cargo vendor` when dependencies change.
- **Moving an existing hub:** between hubs, the transfer code (Phase 5) works
  both ways between Node and Rust (`NEW_HUB_BIN` in the contract suite: 41/41
  Node → Rust and Rust → Node). Onto a debug build, `scripts/android-import-hub.sh`
  copies a `~/.lumora` folder in whole (identity, sign-ins, central link) with
  `run-as`; `am force-stop` doesn't stop Solora (device owner, home screen), so
  it kills the app as itself after the swap.

## Phase 7 — cutover — done 2026-11-04

1. **Contract suite green on both, and on the device.** Node 41/41, Rust 41/41,
   families moving Node ↔ Rust 41/41 each way. `HUB_DEVICE=1` runs the whole
   story against the hub inside the kiosk app on the emulator: 41/41. The
   suite's phones reach it through the emulator's network (`adb emu redir`),
   its own screen through `adb forward`, and its central through
   `adb reverse`; the app is built with `SOLORA_HUB_CENTRAL_URL`,
   `SOLORA_HUB_NAME` and `SOLORA_HUB_OWNER_EMAIL` for the run (harness.mjs).
   The app's own hub data is set aside and put back. Not done: real phones on
   the panel's Wi-Fi, which needs the panel.
2. **Every build uses its in-app hub.** `src/lib/hub-address.ts` is the one
   hub address: always `http://localhost:4000` inside the app, whatever `.env`
   says (`VITE_SERVER_URL=<LAN ip>` in `.env` had been going into Android
   release builds for the central-token fetch). Only a plain browser (vite
   dev) can use `VITE_SOLORA_SERVER_URL`. `VITE_SERVER_URL` and
   `VITE_LUMORA_SERVER_URL` are gone. The app starts its hub on macOS too
   (`SOLORA_HUB=off` to use a separate one).
3. **`kiosk/server` is reference only** (its README says so;
   `scripts/install.sh` refuses unless `SOLORA_NODE_HUB=1`). It stays one
   release as what the contract suite compares against. Before deleting it:
   move `scripts/schema.sql` into `hub/` (the Rust hub embeds it) and
   `tests/contract` beside it, with the Node runs dropped.

## Risks

| Risk | Mitigation |
|---|---|
| Socket.IO edge cases (acks, reconnect, auth errors) differ in socketioxide | Socket probe in Phase 0; test with the real mobile app early (Phase 1) |
| A response differs in a way no test covers | Snapshot whole responses, not just status codes |
| iCal parsing differs from the Node parser (recurrence, time zones) | Feed the same fixture calendars to both and diff the events |
| Android stops the hub when the screen sleeps | Foreground service + device-owner battery exemption (Phase 6), tested with `system_display_sleep` |
| OAuth calendar flows can't be tested without provider credentials | Same as the simulation: stub until credentials exist, flag as untested |
| Phones find the hub by mDNS on some routers but not others | Unchanged from Node; the hub address is also shared via central |
