# Hub contract suite

The hub's behaviour as phones, walls and central see it, written as one
family's story and checked against snapshots. It's Phase 0 of
[the Rust port](../../../docs/hub-rust-port-plan.md): the Rust hub is done
when it passes this suite unchanged.

```bash
npm run test:contract                       # against this Node hub
UPDATE_SNAPSHOTS=1 npm run test:contract    # accept changed responses (review the diff!)
KEEP_CONTRACT_DIR=1 npm run test:contract   # keep logs and data in /tmp/solora-contract-*
HUB_BIN=../src-tauri/target/debug/solora-hub npm run test:contract   # the Rust hub
CONTRACT_CHAPTERS=01,02 npm run test:contract   # only those chapters (each needs the ones before)
```

Needs Postgres's `initdb`/`pg_ctl` on the PATH (Homebrew `postgresql@17`) and
`npm install` in both `central/` and `kiosk/server/`. A run takes ~15 s.

## What it starts

`harness.mjs` makes a folder in `/tmp`, then starts:

- a throwaway Postgres (TCP only) and **central** from `central/src`, migrated;
- the **hub** with `HOME` in that folder, on a free port, with LAN advertising
  off (`SOLORA_MDNS=off`) and Google/Microsoft credentials blanked;
- in chapter 6, a **second hub** to move the family into;
- in chapter 4, a small web server on the LAN address serving a school's
  iCal feed (the hub refuses calendar links on localhost).

`NEW_HUB_BIN` runs chapter 6's new hub as something else (`""` = the Node
hub), so a family moves Node → Rust or Rust → Node.
`HUB_BIN` (one executable) or `HUB_CMD` (split on spaces) replaces the hub
command; it gets `HOME`, `SOLORA_PORT`, `CENTRAL_API_URL` and
`CENTRAL_SOCKET_URL`.

## The story

| Chapter | Covers |
|---|---|
| 01 unboxing | hub info, setup code (hub-only, LAN `403`), first claim, a stranger's `409`, sessions, errors, pairing a second display, display state, central tokens and health |
| 01b central link | the relay (session, blocked paths, wrong key), support routes' permissions, a support request reaching the admin and denied, a Solora action in the family log |
| 02 family | invites, an adult with an account, teen and child phones without accounts, device refresh, tap-to-invite, grandma's invite through central (ECDH), members, a removed kid's phone signing out |
| 03 household | calendars, events, chores, rewards and points, lists, meals, notifications, home layout, away, summer, seasons, phones at the wall, wall commands, snapshot, activity log; with each role's permissions |
| 04 files & calendars | photos (multipart, base64, chunks, static files), the family's iCal feed, a subscribed school calendar (time zones, repeats, removals, broken feeds), Google/Microsoft settings |
| 05 central | the encrypted relay, support access requests and grants, Solora's actions in the family log, a lost display |
| 06 new hub | transfer start/export/photo/finish, the new hub pulling the household |
| 07 live events | every Socket.IO event the family received, first payload of each |

All 121 route handlers are called at least once.

## Snapshots

Each `same(name, response)` compares `{ status, body }` with
`__snapshots__/<name>.json`. Values that change every run are masked by
`shape()`: ids become `<id1>`, `<id2>`… in order of appearance (also inside
strings), ISO times `<time>`, JWTs `<jwt>`, long hex `<hexN>`, today's date
`<today>`, and fields named in `RANDOM_KEYS` (codes, tokens, LAN URLs).
Lists the hub orders by a timestamp that can tie within a second are put in
a fixed order with `sortList` first.

## Not covered

- Real Google/Microsoft OAuth (needs provider credentials) and their sync.
- The minute/hour timers: event reminders, calendar-link and provider sync.
- `POST /auth/kiosk-autologin` with its config file present.
- Finding the old hub by mDNS during a transfer (the test passes `from`).
- Upgrading a pre-central (password) user in `POST /invites/claim`.
