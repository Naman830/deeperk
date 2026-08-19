# ChatSphere e2e harness

Drives the **real** dev servers against the **real** Neon DB. There are no mocks:
REST routes, the Socket.IO server, the internal event bridge, Cloudinary and the
DB-backed rate limiter are all exercised as deployed code paths.

## Running

```bash
npm run dev     # terminal 1 — web (:3000) + socket server (:4000), both required
npm test        # terminal 2 — full suite, serial, ~3–6 min warm
npm test -- specs/60-socket-chat.spec.ts   # one file
```

Env comes from the same files the servers read (root `.env`, `server/.env`,
`web/.env.local`) — nothing is duplicated into `tests/`. Optional:

- `TEST_EMAIL` — a real, plus-addressable inbox. When set, the one full
  OTP-signup test and the email-change test run and send **one or two real
  Brevo emails**; unset, those tests skip with a notice. Everything else sends
  no mail (fixture emails use the reserved `.test` TLD).
- `CALL_RING_TIMEOUT_MS` / `CALL_DISCONNECT_GRACE_MS` (`server/.env`) — the
  three call-timer tests in `65-socket-call` are `it.runIf`-gated and run only
  when the value fits inside a test (≤ 8000ms); the defaults (30000/15000)
  skip them. Set both to e.g. `5000` **and restart the socket server** — the
  harness reads the same env file the server reads at boot, so the gate and
  the server agree only when the server was booted with the current values
  (the bootId guard does not catch env drift).
- `CRON_SECRET` (`web/.env.local`) — gates all of `85-cron-jobs` (the whole
  file skips without it). Because the harness reads the same file the web
  server reads, the value the routes check and the value the spec sends match
  by construction.

## Fixture + cleanup contract

- Every fixture user's username starts with **`zz.e2e.`** and is created via
  Better Auth's own `POST /api/auth/sign-up/email` (no email involved).
- Cleanup (`src/cleanup.ts`) hard-deletes everything reachable from that
  prefix, in FK-dependency order — a **documented exception** to the repo's
  "never hard-delete a `user` row" rule; fixture data is self-contained, so
  nothing real dangles. It runs at global setup (sweeps crashed prior runs)
  and teardown, and is idempotent.
- IP-keyed rate buckets use a per-run `x-forwarded-for` from TEST-NET-3
  (`203.0.113.x`), which the app trusts locally because `TRUSTED_PROXIES` is
  unset — deliberate, see CLAUDE.md.
- **A spec that anonymizes a fixture must restore its identity.** Cleanup
  discovers fixtures via `username LIKE 'zz.e2e.%'` — the anonymizer rewrites
  the username, making the row invisible to cleanup **forever**.
  `85-cron-jobs`'s unconditional `afterAll` writes username/displayUsername/
  email back by captured id; copy that pattern in any future spec that runs
  the anonymizer. The same spec also runs against the **real** Cloudinary
  account: assert only on fixture-owned `avatars/<userId>/` prefixes, and use
  `>=` on the report's global counters.

## Why the suite is serial

One shared `next dev` (compile-on-first-hit) plus per-user in-memory socket
rate limits make parallel files flaky for no wall-clock win. Spec files are
number-prefixed and run alphabetically (custom sequencer in
`vitest.config.ts`).

## The bootId guard

`global-setup.ts` captures `GET :4000/healthz`'s `bootId` and re-asserts it at
teardown. The socket server's rate limiters are **in-memory**, so a nodemon
restart mid-run silently invalidates limit-adjacent assertions — the guard
turns that into a loud failure. Don't edit `server/src` while the suite runs.

## Harness self-check drill

Run once whenever the harness itself changes materially — each mutation below
must turn the named spec red; if it stays green the harness is decorative:

1. Flip one char of `INTERNAL_API_SECRET` in `server/.env` (server restarts) →
   every fan-out test in `70-realtime-bridge` must fail while REST suites stay
   green. Restore it.
2. Add an empty `loading.tsx` beside `web/src/app/(app)/(messaging)/u/[username]/page.tsx`
   → the hard-404 canary in `95-pages` must fail (200). Remove it.
3. Comment one field out of `serializeMessage()` in `server/src/controllers/shared.js` →
   the wire-contract test in `00-contracts` must fail. Restore it.
4. Touch any file under `server/src` mid-run → the run must end red via the
   teardown bootId assert.
5. `Ctrl-C` a run mid-suite, run `npm test` again → global setup's sweep must
   leave zero `zz.e2e.%` users afterwards (`countLeftovers()` in a scratch
   script, or a manual SQL count).

## Deliberately out of scope

Call media (real WebRTC needs a browser — Playwright is the follow-up; the
signaling contract is covered in `65-socket-call`), email deliverability
beyond the flag-gated sends, provider
outage paths (Brevo/Cloudinary 5xx need fault injection), load/perf, and
browser-level interaction (Playwright is the follow-up when visual coverage is
wanted). CI orchestration (booting `next start` + the socket server inside
global setup on alternate ports) is the documented next step for the harness.
