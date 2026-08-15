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
- [ ] Profile — see "Profile — remaining work" below
- [ ] Search
- [ ] Chat (REST + Socket.IO)
- [ ] Call signaling (Socket.IO, `server/`)

### Profile — remaining work

Tracking section for the Profile API build-out (removed once everything below is checked off and the "Profile" line above is ticked instead).

- [x] Core profile fields (`GET`/`PATCH /api/me`) + social links
- [x] Privacy settings (`GET`/`PATCH /api/me/privacy`)
- [x] Public profile view (`GET /api/users/[username]`)
- [x] Username change (`PATCH /api/me/username`, 30-day cooldown) — old-handle 30-day reservation not implemented, no schema for it yet
- [x] Email change flow (`POST /api/me/email/start`, `POST /api/me/email/verify`)
- [x] Delete-account flow (`POST /api/me/delete`, 30-day grace, cancels on next login)
- [ ] Avatar upload — blocked on Cloudinary credentials

### 3. Frontend

- [x] Auth (login, signup, forgot-password pages)
- [ ] Profile
- [ ] Search
- [ ] Chat
- [ ] Call
