# lumora-server

Local Express + Socket.IO server for the Solora kiosk hub.
All household data is stored in SQLite at `$HOME/.lumora/lumora.db`.
Photos are stored as files in `$HOME/.lumora/photos/`.

## Directory layout

```
server/
├── src/
│   ├── index.ts              — server entry point (Express + Socket.IO)
│   ├── db.ts                 — better-sqlite3 connection, migration, helpers
│   ├── types.ts              — shared TypeScript types
│   ├── broadcaster.ts        — Socket.IO emit wrapper used by routes
│   ├── middleware/
│   │   └── auth.ts           — JWT sign/verify, Express + Socket.IO middleware
│   └── routes/
│       ├── auth.ts           — register, login, refresh, session, change-password
│       ├── members.ts
│       ├── invites.ts
│       ├── calendars.ts
│       ├── events.ts
│       ├── chores.ts
│       ├── lists.ts          — lists + list items (nested)
│       ├── meals.ts
│       ├── notifications.ts  — shared content + per-user read/dismiss state
│       └── photos.ts         — multipart upload to disk, static serving
├── scripts/
│   ├── schema.sql            — idempotent SQLite schema (applied at startup)
│   └── install.sh            — build + systemd install script
├── lumora-server.service     — systemd unit template
├── package.json
└── tsconfig.json
```

## Development

```bash
cd server
npm install
npm run dev        # ts-node-dev hot-reload
```

## Production install (Ubuntu)

```bash
cd server
bash scripts/install.sh
```

The unit runs as `lumora-server@<username>.service` under your login user.

## API

Base URL: `http://<kiosk-ip>:4000/api/v1`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /auth/register | — | Create account + household |
| POST | /auth/login | — | Email + password login |
| POST | /auth/refresh | — | Swap refresh token |
| GET | /auth/session | JWT | Current user + household |
| POST | /auth/change-password | JWT | Change password |
| GET/POST | /members | JWT | List / create members |
| PATCH/DELETE | /members/:id | JWT | Update / delete member |
| GET/POST | /invites | JWT | List / create invites |
| GET | /invites/:tokenOrCode | — | Look up invite |
| POST | /invites/claim | — | Claim invite + create account |
| GET/POST/PATCH/DELETE | /calendars/:id | JWT | Calendar CRUD |
| GET/POST/PATCH/DELETE | /events/:id | JWT | Event CRUD |
| GET/POST/PATCH/DELETE | /chores/:id | JWT | Chore CRUD |
| GET/POST/PATCH/DELETE | /lists/:id | JWT | List CRUD |
| POST | /lists/:id/items | JWT | Add list item |
| PATCH/DELETE | /lists/:id/items/:itemId | JWT | Update / delete item |
| GET/POST/PATCH/DELETE | /meals/:id | JWT | Meal CRUD |
| GET/POST/PATCH/DELETE | /notifications/:id | JWT | Notification CRUD |
| POST | /notifications/read-all | JWT | Mark all read |
| DELETE | /notifications | JWT | Dismiss all |
| GET/POST | /photos | JWT | List / upload photo |
| DELETE | /photos/:id | JWT | Delete photo |
| GET | /health | — | Health check |

## Socket.IO

Connect with `{ auth: { token: "<jwt>" } }`.
After authentication the socket is joined to `household:<householdId>`.

Events emitted by the server on every DB mutation:

```
members:created | members:updated | members:deleted
calendars:created | calendars:updated | calendars:deleted
events:created | events:updated | events:deleted
chores:created | chores:updated | chores:deleted
lists:created | lists:updated | lists:deleted
meals:created | meals:updated | meals:deleted
notifications:created | notifications:updated | notifications:deleted
photos:created | photos:deleted
```
