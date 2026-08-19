# ChatSphere realtime server

Express + Socket.IO process that owns chat delivery, presence, and WebRTC call
signaling. It is **event-driven, not REST-driven**: almost all traffic arrives
as Socket.IO events, so the controllers handle socket events; the only REST
surface is the secret-gated `/internal/*` bridge the Next.js app calls.

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

## Ordering rules that are load-bearing (don't "tidy" these)

- `socket/connection.js` registers the chat and call controllers **before any
  awaited work** — Socket.IO drops events with no listener, and a reconnect's
  flushed emit buffer can arrive the instant the transport opens.
- The call controller's `disconnecting` listener must attach **before**
  `connection.js`'s own (registration order = firing order): its last-tab check
  reads presence before `presence.remove()` runs.
- `controllers/call/index.js` clears the user's disconnect-grace timers
  **first** — a reconnect must never let a stale timer stamp them out of a call.
- `serializeMessage()` in `controllers/shared.js` and web's `toChatMessage` must
  emit the identical 17-field shape — pinned by `tests/specs/00-contracts.spec.ts`.

## Running

- Dev: `npm run dev` from `server/` (nodemon, `--env-file=.env`).
- Production: `node server/src/index.js` from the repo root — **not** `npm start`
  when the platform injects env directly (the `--env-file` flag refuses to boot
  without a `.env` file). Builds need the repo root: `src/config/db.js` requires
  `../../../db`.
- Health: `GET /healthz` returns `{ ok, bootId, uptime }`; `bootId` changes on
  every restart (the e2e suite uses it to detect mid-test restarts).

## History note

The pre-2026-08-19 layout kept several of these files at the `src/` root,
frozen so the `feature/message-reactions` branch could be reintegrated by
patch-apply. That patch is now archived at `Docs/patches/message-reactions.patch`
(no longer auto-applicable — port its hunks by hand if reactions return).
