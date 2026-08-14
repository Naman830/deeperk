# CLAUDE.md

Context for Claude Code (or any future contributor) working in this repo. Keep this updated as major architectural work lands — it's meant to save a future session from re-deriving decisions that were already made and reasoned through once.

## Project

**ChatSphere** (`webRtc_Project`) — real-time chat + WebRTC audio/video calling. Monorepo: `web/` (Next.js/TypeScript, Better Auth) and `server/` (Express/Socket.IO, signaling — not yet built) share one Neon Postgres database via `db/` at the repo root.

Full functional specs live in `Docs/`: [`user/auth.md`](Docs/user/auth.md), [`user/profile.md`](Docs/user/profile.md), [`user/search.md`](Docs/user/search.md), [`chat/chat.md`](Docs/chat/chat.md), [`call/call.md`](Docs/call/call.md), and the DB connection architecture in [`database/db-connection.md`](Docs/database/db-connection.md). Those docs are the source of truth for *behavior*; this file tracks *decisions made while implementing against them* that aren't written down anywhere else.

## Database Schema — status: implemented, not yet pushed to Neon

`db/schema/` was empty at the start of this work. It's now fully built out (13 tables, 6 domain enums, across `auth/`, `profile/`, `chat/`, `call/`) — see [`Docs/database/schema.md`](Docs/database/schema.md) for the full table-by-table reference. This section is the *why* behind it; that doc is the *what*.

### Decisions confirmed with the project owner

These were genuinely open — the domain docs specified *behavior* in detail but left these structural choices unstated. Each was asked as a clarifying question before writing any schema code; all recommended defaults were accepted.

1. **ID generation:** `crypto.randomUUID()` (Node's built-in `node:crypto`, no new dependency) for every `text("id")` primary key. Not cuid2/nanoid.
2. **Enum implementation — hybrid:** native Postgres `pgEnum` for stable, unlikely-to-churn sets (`conversation.type`, `conversation_member.role`, `message.type`, `call.kind`, `call.status`, `pending_contact_change.type`). Plain `text` + app-level validation (Zod, not yet wired up) for `privacy_settings`'s three audience columns (`discoverable`, `online_status`, `profile_details`) specifically, because `profile.md` says those will grow soon (`FRIENDS`, `FRIENDS_OF_FRIENDS`) and native enums need an `ALTER TYPE` to extend — awkward under this project's `drizzle-kit push` workflow. **If you add a new status/type-like column, ask which bucket it belongs in rather than defaulting to one or the other.**
3. **Future-but-unbuilt tables omitted:** `follow` (followers/friends graph), `reaction` (message reactions), `recent_search` (search history) are all described in the docs as planned but have no feature spec yet. They are **not** in the schema. Add each one in its own follow-up once its feature doc exists — don't scaffold ahead of the spec.
4. **`privacy_settings.friendRequests` — a real cross-doc conflict, resolved:** `chat.md`'s intro references this column as if it already existed; `profile.md` (the table's actual owning/authoritative doc) never defines it and explicitly states there's no `FRIENDS` tier yet. Treated `profile.md` as authoritative — **the column does not exist.** If you're implementing the `follow` feature later and need this, that's new schema work, not something to "restore."
5. **`ON DELETE RESTRICT` uniformly on FKs from historical tables to `user`:** `conversation.createdById`, `conversation_member.userId`, `call.startedById`, `call_participant.userId` all use `RESTRICT`, matching the docs' explicit rule for `message.senderId`. `user` rows are never hard-deleted (soft-scheduled, then anonymized in place by a nightly job — not yet built), so this never actually fires in normal operation; it exists purely as a guardrail against an out-of-band hard delete silently destroying chat/call history. Ephemeral/decorative companion tables (`account`, `session`, `social_link`, `privacy_settings`, `pending_contact_change`) use `CASCADE` instead — they have no meaning without their user.

### Other assumptions made (lower-stakes, documented for transparency)

- `user.isOnline` / `user.lastSeenAt` live on `user`, even though only `chat.md` (not `auth.md`/`profile.md`) mentions them — chat's presence feature genuinely needs them now, this isn't a speculative future column.
- All timestamps are `timestamptz`; `birthDate` is `date` (no time-of-day meaning).
- `pending_registration.expiresAt` uses the 5-minute OTP-validity window, not the 15-minute figure elsewhere in `auth.md` (that one belongs to the post-verification httpOnly registration-token cookie, which isn't a DB row at all).
- A couple of tables got a plain `createdAt` audit column even where the docs' field list didn't explicitly list one (e.g. `social_link`), for operational consistency across the schema.
- Username case-insensitive uniqueness relies on the app always writing lowercase (per `auth.md`'s own "stored lowercase" statement) plus a plain unique index — not a `lower(username)` expression index. Low risk, but worth knowing if a bug ever surfaces two usernames differing only by case.

### Known risk to close out before the first real migration

**Better Auth conformance is unverified.** `account`, `session`, `verification` were built to Better Auth's commonly documented table shape, but **Better Auth is not yet in `package.json`** — nothing has run its actual schema generator against it. Before running `drizzle-kit push` against a database anyone will actually authenticate against, install Better Auth, run its CLI schema generation, and diff the output against `db/schema/auth/account.js`, `session.js`, `verification.js`. Hand-guessing an auth library's schema is exactly the kind of thing that breaks in a way that's annoying to debug later.

### Verification already done

`npx drizzle-kit generate` was run against a scratch config (not the real `DATABASE_URL`) to confirm the schema compiles to valid SQL: 13 tables, all expected FKs with the correct `ON DELETE` behavior, and all expected indexes. **It has not been pushed to the project's real Neon database yet** — that's a deliberate stopping point (pushing schema to a real external database is an outward action), not an oversight. Run `npx drizzle-kit push` when ready.

### File layout

```
db/schema/
├── index.js          root barrel (consumed by drizzle.config.js and db/index.js)
├── auth/              user, account, session, verification, pending_registration
├── profile/           social_link, privacy_settings, pending_contact_change
├── chat/               conversation, conversation_member, message
└── call/               call, call_participant
```

One file per table (not one file per domain) — each domain's `index.js` barrel re-exports every table in that folder; the root barrel re-exports every domain. See [`Docs/database/db-connection.md`](Docs/database/db-connection.md) for why this structure matters (a table not re-exported from its barrel is silently never created).

## Conventions worth knowing before touching this repo

- **CommonJS everywhere in `db/`** (`require`/`module.exports`), matching the existing style in `db/index.js` — not ESM, even though `web/` is TypeScript/ESM-flavored.
- **Never hard-delete a `user` row.** Every piece of history (messages, calls, conversations) is written to assume `user` rows persist forever, possibly anonymized. If you're ever tempted to `DELETE FROM user`, that's a sign something upstream should have been a soft-delete/anonymization step instead.
- Domain docs in `Docs/` occasionally get ahead of each other (see decision #4 above) — when a table's *behavior* is described in a doc that doesn't *own* that table, treat the owning domain's doc as authoritative and flag the discrepancy rather than silently reconciling it one way.
