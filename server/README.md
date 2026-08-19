# ChatSphere realtime server

Express + Socket.IO process that owns chat delivery, presence, and WebRTC call
signaling. It is **event-driven, not REST-driven**: almost all traffic arrives as
Socket.IO events, so the codebase uses the socket-world names for the classic
Express layers. The mapping is exact:

| Classic Express layer | Here | Files |
|---|---|---|
| `routes/` + `controllers/` (HTTP) | `src/http/` | `internal.js` — the only REST surface: secret-gated `/internal/*` endpoints called by the Next.js app (fan-out notifications, call kicks) |
| `controllers/` (event handlers) | `src/handlers/` | `chat.js`, `call.js`, `notify.js` — one file per domain; each validates input, checks authorization, mutates state, acks/broadcasts |
| `middlewares/` + app bootstrap | `src/socket/` | `auth.js` (handshake cookie auth — the socket equivalent of auth middleware), `create-io.js` (Socket.IO server construction + CORS), `connection.js` (per-socket wiring: registers every handler), `session-sweep.js` (periodic session revalidation) |
| `services/` (domain state + shared logic) | `src/` root | `presence.js` (online users), `active-calls.js` (live-call state machine), `rooms.js` (room membership + names), `rate-limit.js` (in-memory limiter), `media-token.js` (HMAC media-token verifier) |
| `config/` | `src/` root | `env.js` (validated env — refuses to boot on bad config), `db.js` (Drizzle/Neon re-export from the repo-root `db/`) |
| entry point (`app.js`/`server.js`) | `src/index.js` | wiring only: Express app, `/healthz`, http.Server, Socket.IO attach, boot reconciliation, graceful shutdown |

```
server/src/
├── index.js              # entry point — wiring only, no business logic
│
│   # -- config --
├── env.js                # validated environment (fail-fast on boot)
├── db.js                 # db client + schema + drizzle ops, re-exported from ../../db
│
│   # -- services (domain state + shared logic) --
├── presence.js           # who's online (in-memory map + DB flush)
├── active-calls.js       # live-call state machine (busy checks, timers, caps)
├── rooms.js              # socket.io room names + membership checks
├── rate-limit.js         # in-memory sliding-window limiter
├── media-token.js        # verifies HMAC media tokens minted by the web app
│
├── handlers/             # = controllers, one per domain (socket events)
│   ├── chat.js           # message send/edit/delete, receipts, typing
│   ├── call.js           # call invite/accept/join/leave + WebRTC signal relay
│   └── notify.js         # fan-out helpers (toUsers / toConversation)
│
├── http/                 # = routes + controllers for the REST surface
│   └── internal.js       # secret-gated /internal/* endpoints for the web app
│
└── socket/               # = middleware + bootstrap for the socket transport
    ├── auth.js           # handshake auth (Better Auth session cookie)
    ├── create-io.js      # Socket.IO server construction + CORS
    ├── connection.js     # per-socket setup: presence, rooms, handler registration
    └── session-sweep.js  # periodic revalidation of connected sockets' sessions
```

## Why the service/config files sit at the `src/` root (do not "fix" this)

`presence.js`, `rooms.js`, `rate-limit.js`, `media-token.js`, `handlers/chat.js`
and `handlers/notify.js` are **frozen at their current paths** — the
`feature/message-reactions` branch is reintegrated by patch-applying
`git diff main feature/message-reactions`, which carries hunks inside those
files and require-paths pointing at them. `env.js` and `db.js` are pinned too,
because the frozen files' require blocks (`./env`, `../db`, …) may not be
edited. Moving any of them into a `services/`/`config/` folder breaks that
patch and forfeits the preserved reactions feature.

The follow-up restructure is already planned for immediately after that
reintegration (see the "Server restructure" section of `CLAUDE.md`): move
`rooms`/`presence`/`notify` into `socket/`, and split `handlers/chat.js` into
`handlers/chat/{index,shared,send,delete,edit,receipts,typing}.js`.

## Running

- Dev: `npm run dev` from `server/` (nodemon, `--env-file=.env`).
- Production: `node server/src/index.js` from the repo root — **not** `npm start`
  when the platform injects env directly (the `--env-file` flag refuses to boot
  without a `.env` file). Builds need the repo root: `src/db.js` requires `../../db`.
- Health: `GET /healthz` returns `{ ok, bootId, uptime }`; `bootId` changes on
  every restart (the e2e suite uses it to detect mid-test restarts).
