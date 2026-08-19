# ChatSphere — Realtime Server

![Node.js](https://img.shields.io/badge/Node.js-20+-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)
![Socket.IO](https://img.shields.io/badge/Socket.IO-4.8-010101?logo=socket.io&logoColor=white)
![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black)
![Neon](https://img.shields.io/badge/Neon-Postgres-00E599?logo=postgresql&logoColor=white)

The Express + Socket.IO process that powers everything *live* in ChatSphere: message
delivery, typing indicators, presence, read receipts, and WebRTC call signaling.

It is **event-driven, not REST-driven**. Almost all traffic arrives as Socket.IO
events, so the "controllers" here handle socket events rather than HTTP routes. The
only REST surface is a secret-gated `/internal/*` bridge that the Next.js app (in
[`../web`](../web)) calls when it needs to fan out an event — for example, after a
REST-side action like blocking a user or forwarding a message.

Persistence lives in the shared [`../db`](../db) schema on Neon Postgres — this
process reads and writes the same database as the web app, and the two stay in sync
through a hand-mirrored socket contract (see [Socket events](#-socket-events)).

---

## 📑 Table of contents

- [How it fits into the monorepo](#-how-it-fits-into-the-monorepo)
- [Getting started](#-getting-started)
- [Environment variables](#-environment-variables)
- [Project structure](#-project-structure)
- [Socket events](#-socket-events)
- [HTTP surface](#-http-surface)
- [Ordering rules that are load-bearing](#%EF%B8%8F-ordering-rules-that-are-load-bearing)
- [Deployment](#-deployment)
- [History note](#history-note)

---

## 🧩 How it fits into the monorepo

```
webRtc_Project/
├── web/       Next.js app — auth, REST APIs, all UI          (talks to this server via /internal + sockets)
├── server/    ← you are here — realtime delivery + signaling
├── db/        shared Drizzle schema, one Neon database
├── Docs/      behavioral specs (chat.md and call.md govern this server)
└── tests/     e2e suite that drives BOTH processes together
```

The browser authenticates its socket handshake with the **same Better Auth session
cookie** the web app issues — this server validates it by calling back into Next
(`WEB_INTERNAL_URL`), so it never holds auth logic of its own.

The full behavioral specs live in [`Docs/chat/chat.md`](../Docs/chat/chat.md) and
[`Docs/call/call.md`](../Docs/call/call.md); those documents are the source of truth
for *what* this server does. This README covers *how it is built and run*.

## 🚀 Getting started

**Prerequisites:** Node.js 20+ (for the built-in `--env-file` flag) and a Neon
Postgres database that already has the schema pushed (see the root README).

```bash
# 1. Install — from the REPO ROOT, not from server/.
#    server/ requires ../../db, so a solo install misses shared dependencies.
npm install

# 2. Configure — copy the relevant block from the root .env.example
cp .env.example server/.env   # then trim to the server section and fill it in

# 3. Run (from server/)
npm run dev                   # nodemon, restarts on change
```

The server boots on port **4000** by default and fails fast — a missing
`DATABASE_URL` or a malformed `ICE_SERVERS` refuses to start rather than limping
along half-configured. A clean boot logs the bound port; verify with:

```bash
curl http://localhost:4000/healthz
# → { "ok": true, "bootId": "…", "uptime": 1.23 }
```

## 🔧 Environment variables

All configuration is read **once at boot** by [`src/config/env.js`](src/config/env.js)
and validated before anything else loads. There is deliberately no `dotenv` — the npm
scripts use Node's `--env-file=.env`, which populates the environment before any
module (including the DB client) is required. Reference values live in the root
[`.env.example`](../.env.example); never commit real credentials.

| Variable | Required | Purpose |
| --- | :---: | --- |
| `DATABASE_URL` | ✅ | Neon Postgres connection string — must match the web app's. Boot refuses without it. |
| `SOCKET_PORT` | — | Port to listen on. Falls back to `PORT` (host-injected), then `4000`. |
| `WEB_ORIGIN` | — | Comma-separated browser origins allowed by CORS and the handshake origin check. Default `http://localhost:3000`. Never `*`. |
| `WEB_INTERNAL_URL` | — | Where to reach Next for session validation. Separate from `WEB_ORIGIN` because in production this may be a private address. |
| `INTERNAL_API_SECRET` | ✅ | Shared secret for `POST /internal/events`. **Must be identical in `web/.env.local`.** |
| `MEDIA_SIGNING_SECRET` | ✅ | Verifies HMAC media tokens minted by the web app's upload route. **Must be identical in `web/.env.local`** — a mismatch rejects every media message. |
| `ICE_SERVERS` | — | JSON array of `{urls, …}` objects handed to call clients. Unset → Google STUN only. Malformed JSON **refuses to boot** on purpose. |
| `CALL_RING_TIMEOUT_MS` | — | How long an unanswered call rings before going `MISSED` (default `30000`). |
| `CALL_DISCONNECT_GRACE_MS` | — | How long a mid-call participant's last socket may be gone before they're stamped out (default `15000`, deliberately longer than the client's 8s peer grace). |
| `SOCKET_SINGLE_INSTANCE` | — | Default `true`. Set `false` **before** ever running a second socket process — the boot-time "everyone is offline" presence reset is only correct with exactly one instance. |

## 📁 Project structure

An Express-idiom layout: `index.js` is wiring only, domain state lives in
`services/`, and every socket event handler lives in a `controllers/` module named
after what it does.

```
server/src/
├── index.js                 # entry point — wiring only, no business logic
│
├── config/
│   ├── env.js               # validated environment (fail-fast on boot)
│   └── db.js                # db client + schema + drizzle ops, re-exported from ../../db
│
├── middlewares/
│   └── auth.js              # handshake auth (Better Auth session cookie)
│
├── services/                # domain state + shared logic
│   ├── presence.js          # who's online (in-memory map + DB flush)
│   ├── active-calls.js      # live-call state machine (busy checks, timers, caps)
│   ├── rooms.js             # socket.io room names + membership checks
│   ├── rate-limit.js        # in-memory sliding-window limiter
│   └── media-token.js       # verifies HMAC media tokens minted by the web app
│
├── controllers/             # socket event handlers, one folder per domain
│   ├── shared.js            # fail(), serializeMessage(), sendIsBlocked() — chat + call
│   ├── notify.js            # fan-out helpers (toUsers / toConversation / presence)
│   ├── chat/
│   │   ├── index.js         # registerChatHandlers — registers the modules below
│   │   ├── shared.js        # chat-only constants (NOT_FOUND/BLOCKED, max length)
│   │   ├── send.js          # message:send (media tokens, replies, retry dedupe)
│   │   ├── delete.js        # message:delete + message:delete-for-me
│   │   ├── edit.js          # message:edit
│   │   ├── receipts.js      # conversation:delivered + conversation:read
│   │   └── typing.js        # typing:start / typing:stop
│   └── call/
│       ├── index.js         # registerCallHandlers — grace-timer clear + registration
│       ├── shared.js        # constants, listMembers, toCallUser, endsWithoutUser
│       ├── end-call.js      # endCall — the ONE finalizer every terminal path uses
│       ├── invite.js        # call:invite + the hour-safe invite limiter
│       ├── join.js          # call:accept / call:join (accept-while-ONGOING is a join)
│       ├── controls.js      # call:cancel / call:reject / call:leave
│       ├── signal.js        # rtc:signal relay + call:mute-state
│       ├── state.js         # call:state resync after connect/reconnect
│       ├── disconnect.js    # disconnecting listener + disconnect grace timer
│       └── kick.js          # kickFromConversationCall (used by routes/internal.js)
│
├── routes/
│   └── internal.js          # secret-gated POST /internal/events for the web app
│
└── socket/                  # transport bootstrap
    ├── create-io.js         # Socket.IO server construction + CORS + handshake middleware
    ├── connection.js        # per-socket setup: handler registration, presence, rooms
    └── session-sweep.js     # periodic revalidation of connected sockets' sessions
```

## 🔌 Socket events

The contract is mirrored **by hand** with the web client
(`web/src/lib/chat/types.ts` and `web/src/lib/call/*`) — there is no codegen, so a
change on either side must land on both. The message payload shape (18 fields) is
pinned by `tests/specs/00-contracts.spec.ts`.

**Client → server** (each handled by the controller of the same name above):

| Domain | Events |
| --- | --- |
| Messaging | `message:send` · `message:edit` · `message:delete` · `message:delete-for-me` |
| Receipts | `conversation:read` · `conversation:delivered` |
| Typing | `typing:start` · `typing:stop` |
| Calls | `call:invite` · `call:accept` · `call:join` · `call:cancel` · `call:reject` · `call:leave` · `call:state` · `call:mute-state` |
| WebRTC | `rtc:signal` (SDP/ICE relay between peers) |

**Server → client** (broadcast through `controllers/notify.js`):

| Domain | Events |
| --- | --- |
| Messaging | `message:new` · `message:edited` · `message:deleted` · `message:hidden` |
| Receipts | `conversation:read-by` · `conversation:read-sync` · `conversation:delivered` · `conversation:self-changed` |
| Presence | `presence:online` · `presence:offline` · `presence:snapshot` (connect-time: co-members already online, privacy-filtered) · `session:ready` |
| Calls | `call:ring` · `call:ring-cancelled` · `call:ring-handled` · `call:started` · `call:participant-joined` · `call:participant-left` · `call:ended` |

Failure acks are always the flat shape `{ ok: false, code, error }`;
`conversation:delivered` and `typing:*` are fire-and-forget with no ack at all.

## 🌐 HTTP surface

Two routes, nothing else:

- **`GET /healthz`** — returns `{ ok, bootId, uptime }`. `bootId` changes on every
  restart; the e2e suite uses it to detect a mid-test restart.
- **`POST /internal/events`** — the bridge the Next.js app calls to fan out events
  it originated (REST-side deletes, blocks, forwards…). Guarded by a
  constant-time comparison against `INTERNAL_API_SECRET` and never exposed to
  browsers.

## ⚠️ Ordering rules that are load-bearing (don't "tidy" these)

These look like arbitrary ordering and are not — each one exists because the
reverse order loses events or corrupts state:

- `socket/connection.js` registers the chat and call controllers **before any
  awaited work** — Socket.IO drops events with no listener, and a reconnect's
  flushed emit buffer can arrive the instant the transport opens.
- The call controller's `disconnecting` listener must attach **before**
  `connection.js`'s own (registration order = firing order): its last-tab check
  reads presence before `presence.remove()` runs.
- `controllers/call/index.js` clears the user's disconnect-grace timers
  **first** — a reconnect must never let a stale timer stamp them out of a call.
- `serializeMessage()` in `controllers/shared.js` and web's `toChatMessage` must
  emit the identical 18-field shape — pinned by `tests/specs/00-contracts.spec.ts`.

## 🚢 Deployment

The full plan lives in [`Docs/deployment/deploy.md`](../Docs/deployment/deploy.md)
(Render free tier). The three facts that bite if forgotten:

- **Start command is `node server/src/index.js` from the repo root** — not
  `npm start`. The npm script's `--env-file=.env` makes Node refuse to boot when no
  `.env` file exists, and hosts like Render inject env directly.
- **Build from the repo root** (`npm ci --omit=dev`) — `src/config/db.js` requires
  `../../db`, so a `server/`-only build is missing half its code.
- `PORT` is honoured automatically as a fallback for `SOCKET_PORT`, so Render's
  injected port needs no extra config.

## History note

The pre-2026-08-19 layout kept several of these files at the `src/` root,
frozen so the `feature/message-reactions` branch could be reintegrated by
patch-apply. That patch is now archived at `Docs/patches/message-reactions.patch`
(no longer auto-applicable — port its hunks by hand if reactions return).
