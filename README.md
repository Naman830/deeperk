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
- [ ] Chat (REST + Socket.IO)
- [ ] Call signaling (Socket.IO, `server/`)

### Deferred background jobs

Not part of any API surface — both need a scheduler, and none is chosen yet. Neither is user-visible when missing, which is exactly why they're easy to forget:

- [ ] Nightly anonymizer for accounts past their 30-day `deletionScheduledAt` window. Should also destroy the user's `avatars/<userId>/` folder, and can sweep `reserved_username` rows where `expires_at < now()` in the same pass.
- [ ] Nightly orphaned-Cloudinary-asset sweep — list the `avatars/<userId>/` prefix, delete anything that isn't that row's current `avatarPublicId`.

### 3. Frontend

- [x] Auth (login, signup, forgot-password pages)
- [x] Profile (app shell, `/settings/*`, `/u/[username]`)
- [x] Search (in the chats column + standalone `/search`)
- [x] UX pass (collapsible rail persisted across reloads, mobile fixes, loading/error/404 boundaries, one error channel)
- [ ] Chat
- [ ] Call

### 4. Verify

- [x] Auth / Profile / Search verified end-to-end against the real Neon DB and a running `next dev` (66 API checks + 21 page-render checks). See CLAUDE.md → "End-to-end verification pass".
- [ ] **Cloudinary API key can't upload.** Credentials are set and `ping()` works, but the key is restricted: uploads 403 with `missing permissions (actions=["create"])`. Grant `create`+`read`, or use an unrestricted key. Avatar upload is the only feature blocked; all of its validation is verified.
- [ ] **Set `TRUSTED_PROXIES`** before deploying, or every IP-keyed rate limit is bypassable via a client-supplied `x-forwarded-for`.
- [ ] Chat / Call verification (once built)
