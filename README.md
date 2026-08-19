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

### Background jobs — built, on Vercel Cron

Two `CRON_SECRET`-protected Next route handlers under `web/src/app/api/cron/`, scheduled nightly by `web/vercel.json` (Vercel Cron; e2e-covered by `tests/specs/85-cron-jobs.spec.ts`; decisions in `CLAUDE.md` → "Nightly cron jobs"):

- [x] Nightly anonymizer (`/api/cron/anonymize-accounts`, 03:00 UTC) for accounts past their 30-day `deletionScheduledAt` window — anonymizes the row in place, revokes sessions, scrubs companion rows, destroys the `avatars/<userId>/` folder, and sweeps expired `reserved_username` rows in the same pass.
- [x] Nightly orphaned-Cloudinary-asset sweep (`/api/cron/sweep-avatars`, 05:00 UTC) — lists the `avatars/` prefix, deletes anything that isn't some user's current `avatarPublicId` (assets younger than 24h are spared as possible in-flight uploads).

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

### Deploy-day checklist

Pure environment configuration — nothing to code, nothing meaningful until something is deployed. [`Docs/deployment/deploy.md`](Docs/deployment/deploy.md) carries the exact copy-paste instructions for each:

- **`TRUSTED_PROXIES`** — leave **unset on Vercel** (it overwrites `x-forwarded-for`, so the value is already trustworthy). Set it to your proxy's CIDRs only on a self-hosted deploy behind your own nginx/LB — there, unset means every IP-keyed rate limit is bypassable via a client-supplied header.
- **TURN relay (`ICE_SERVERS` on the socket host)** — STUN-only fails for ~10–15% of strict-NAT networks. One env var on Render (Cloudflare Calls TURN or Metered Open Relay are the free options), no code change; malformed JSON refuses to boot by design.
- **`CRON_SECRET` on Vercel** — without it both nightly cron jobs answer 403 (fail closed) and never run.

### Remaining call work (feature is live; these are the known follow-ups)

- [x] **`/calls/[id]` detail page + history pagination UI** — detail pane (summary + per-participant roster + call-back CTA), "Load more" pagination over `listCallHistory`'s keyset cursors via the new `GET /api/calls`, rows linkified. e2e: `tests/specs/55-call-history-rest.spec.ts` + `95-pages.spec.ts`.
- [x] **`(started_at, id)` index on `call`** (`idx_call_started_at_id`) for the cross-conversation history feed — pushed to Neon alongside the detail-page work.
- [x] **Move the notification-prefs store under `lib/`** — now `web/src/lib/realtime/notification-prefs.ts`; the repo's only lib→components import is gone.
- [ ] **Browser-level call media e2e (Playwright)** — `tests/specs/65-socket-call.spec.ts` covers the full signaling contract with raw sockets; real `RTCPeerConnection`/`getUserMedia` media flow needs a browser harness. *(Deliberately deferred — its own workstream.)*
- [ ] **Push notifications for calls when the tab is closed** — same Web Push gap chat.md §9 flags; a missed call is the strongest case for building it. *(Deliberately deferred — its own workstream.)*
- [ ] Screen sharing, >4-person calls (SFU), recording/transcription, background blur — unchanged future work per `Docs/call/call.md` §9.

*(TURN relay moved to the Deploy-day checklist above — it's config, not code.)*
