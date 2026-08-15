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
- [ ] Profile
- [ ] Search
- [ ] Chat (REST + Socket.IO)
- [ ] Call signaling (Socket.IO, `server/`)

### 3. Frontend

- [x] Auth (login, signup, forgot-password pages)
- [ ] Profile
- [ ] Search
- [ ] Chat
- [ ] Call
