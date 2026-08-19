# ChatSphere

Real-time chat + WebRTC audio/video calling. Monorepo: `web/` (Next.js, Better Auth), `server/` (Express/Socket.IO signaling), `db/` (shared Neon Postgres schema).

## Workflow

Build order — each stage covers the *whole app*, not one feature at a time:

1. **Planning** — spec the feature in `Docs/` first (skip if a spec already exists).
2. **DB** — model every table for every feature in `db/schema/` before touching API code.
3. **API** — REST endpoints + Socket.IO signaling events, built per feature, against the finished schema.
4. **Frontend** — UI per feature, built against the finished API.

Tick a task off below when it's done, and update `CLAUDE.md` with any decision made along the way.

## Tasks

### 1. DB (whole schema)

- [x] Auth tables (`user`, `account`, `session`, `verification`, `pending_registration`, `rate_limit_hit`)
- [x] Profile tables (`social_link`, `privacy_settings`, `pending_contact_change`)
- [x] Chat tables (`conversation`, `conversation_member`, `message`)
- [x] Call tables (`call`, `call_participant`)
- [x] Push schema to Neon (`drizzle-kit push`)

### 2. API (REST + Socket.IO)

- [x] Auth (signup OTP flow, login, forgot-password — Better Auth)
- [x] Profile (fields, privacy, public view, username + 30-day hold, email change, delete, avatar)
- [x] Search (`GET /api/users/search`)
- [x] Chat (REST + Socket.IO)
- [x] Chat UX expansion — all 4 phases built (see `CLAUDE.md` for the decisions).
      Phase 1: delete-for-me, three-way delete dialog, long-press/right-click menu, mobile
      bubble sizing. Phase 2: reply, edit, forward, copy, multi-select, autolinking.
      Phase 3: read receipts, unread divider, toast rework, Settings → Notifications.
      Phase 4: pin/mute/archive/block, clear & delete chat, in-chat search, image reflow fix.
      Plus @mentions in groups and a per-chat media gallery. Schema is pushed and verified.
      Message reactions were built and then deliberately held back — they live on the
      `feature/message-reactions` branch, not on `main`.
- [x] Call signaling (Socket.IO, `server/`) — `handlers/call.js` + `active-calls.js`: invite/ring/accept/join/leave/reject/cancel, verbatim `rtc:signal` relay, busy + 4-cap + one-call-per-conversation enforcement, 30s ring timer, 15s disconnect grace, boot reconciliation, CALL history bubble. See `CLAUDE.md` → "Calls" and `Docs/call/call.md` §8.1 for the decisions.

### Deferred background jobs

Not part of any API surface — both need a scheduler, and none is chosen yet. Neither is user-visible when missing, which is exactly why they're easy to forget:

- [ ] Nightly anonymizer for accounts past their 30-day `deletionScheduledAt` window. Should also destroy the user's `avatars/<userId>/` folder, and can sweep `reserved_username` rows where `expires_at < now()` in the same pass.
- [ ] Nightly orphaned-Cloudinary-asset sweep — list the `avatars/<userId>/` prefix, delete anything that isn't that row's current `avatarPublicId`.

### 3. Frontend

- [x] Auth (login, signup, forgot-password pages)
- [x] Profile (app shell, `/settings/*`, `/u/[username]`)
- [x] Search (in the chats column + standalone `/search`)
- [x] UX pass (collapsible rail persisted across reloads, mobile fixes, loading/error/404 boundaries, one error channel)
- [x] Chat
- [x] Call — in-repo `CallPeer` wrapper (no simple-peer), global call overlay (full-screen, minimizable floating tile), incoming-ring modal + synthesized ringtone, group mesh tiles, thread-header call buttons, group "Join call" banner, per-viewer CALL bubbles, `/calls` history page with call-back

### 4. Verify

- [x] Auth / Profile / Search verified end-to-end against the real Neon DB and a running `next dev` (66 API checks + 21 page-render checks). See CLAUDE.md → "End-to-end verification pass".
- [x] **Cloudinary API key works** (re-verified 2026-08-17). `ping()`, `usage()`, and a real upload + destroy all succeed for both `image` and `raw` resource types. The earlier `actions=["create"]` 403 is gone, so nothing is blocked on credentials.
- [x] **Chat verified end-to-end — and the harness is now permanent** (2026-08-18). `tests/` is a checked-in Vitest suite (11 files, ~133 assertions: every REST route, every socket event, the internal event bridge, pages) run with `npm test` against `npm run dev` + the real Neon DB; see `tests/README.md`. It found and pinned one real server bug (sends emitted right after `session:ready` were silently dropped) and the unread-divider misplacement.
- [ ] **Set `TRUSTED_PROXIES`** before deploying, or every IP-keyed rate limit is bypassable via a client-supplied `x-forwarded-for`.

### Remaining call work (feature is live; these are the known follow-ups)

- [ ] **TURN relay at deploy time** — STUN-only fails for ~10–15% of strict-NAT networks. Config-only: set `ICE_SERVERS` in the socket server's env (Cloudflare Calls TURN or Metered Open Relay are the free options — see `Docs/deployment/deploy.md`). No code change.
- [ ] **Browser-level call media e2e (Playwright)** — `tests/specs/65-socket-call.spec.ts` covers the full signaling contract with raw sockets; real `RTCPeerConnection`/`getUserMedia` media flow needs a browser harness.
- [ ] **`/calls/[id]` detail page + history pagination UI** — `listCallHistory` already returns keyset cursors and the `/calls` layout already routes `/calls/*` as a detail pane; only the UI is missing (first 50 calls shown today).
- [ ] **`(started_at, id)` index on `call`** for the cross-conversation history feed — the existing index leads with `conversation_id` and can't serve it; fine at current scale, add via `drizzle-kit push` when history grows.
- [ ] **Push notifications for calls when the tab is closed** — same Web Push gap chat.md §9 flags; a missed call is the strongest case for building it.
- [ ] **Move the notification-prefs store under `lib/`** — `session.ts` currently holds the repo's only lib→components import (documented in `CLAUDE.md` → "Calls").
- [ ] Screen sharing, >4-person calls (SFU), recording/transcription, background blur — unchanged future work per `Docs/call/call.md` §9.
