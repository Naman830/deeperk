# Deeperk — Web App

![Next.js](https://img.shields.io/badge/Next.js-16.3-000000?logo=next.js&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![Better Auth](https://img.shields.io/badge/Better_Auth-1.6-7C3AED)
![Drizzle ORM](https://img.shields.io/badge/Drizzle-ORM-C5F74F?logo=drizzle&logoColor=black)
![Vercel](https://img.shields.io/badge/Deploys_to-Vercel-000000?logo=vercel&logoColor=white)

The Next.js face of **Deeperk** — a real-time chat and calling app. Everything a
user sees and every REST endpoint lives here: OTP-gated signup, profiles with
granular privacy, people search, a Telegram-grade chat experience, and WebRTC
audio/video calls. Live delivery itself is handled by the sibling Socket.IO process
in [`../server`](../server); this app connects to it as a client and shares one Neon
Postgres database through the [`../db`](../db) schema.

---

## 📑 Table of contents

- [Features](#-features)
- [Tech stack](#-tech-stack)
- [Getting started](#-getting-started)
- [Environment variables](#-environment-variables)
- [Project structure](#-project-structure)
- [Testing](#-testing)
- [Deployment](#-deployment)
- [Where the real specs live](#-where-the-real-specs-live)

---

## ✨ Features

**🔐 Authentication** — a fully custom multi-step signup (email → 6-digit OTP →
profile → password) built on top of Better Auth, which handles sessions, sign-in,
password reset, and username rules. Rate limiting is DB-backed with the spec's exact
per-email and per-IP budgets. Transactional email goes through Brevo.

**👤 Profiles & privacy** — editable profile with bio and social links, Cloudinary
avatars (EXIF stripped, magic-byte sniffed before any image parsing, cropped
client-side), a 30-day username-change cooldown with a 30-day hold on the old
handle, OTP-verified email change, and account deletion as a 30-day soft schedule
that any sign-in cancels. Privacy settings (`discoverable`, `onlineStatus`,
`profileDetails`) gate every read — including read receipts.

**🔎 Search** — prefix search over usernames and names, honouring `discoverable`
and blocks, surfaced both at `/search` and inline in the chats column.

**💬 Chat** — DMs and groups with replies, edits, delete-for-me / delete-for-everyone,
forwarding, @mentions in groups, per-chat mute/pin/archive/clear, read and delivery
receipts (privacy-aware, weakest-link in groups), typing indicators, presence,
image/video/file attachments, voice notes with recorded-duration playback, in-chat
search, a per-chat media gallery, unread dividers, and toast/sound/title-blink
notifications with per-device preferences.

**📞 Calls** — WebRTC audio/video, 1:1 and group (up to 4), built on native
`RTCPeerConnection` with no wrapper library. Ring/busy/missed semantics, mid-call
reconnect grace, mute state sync, synthesized ringtone, and a paginated call history
at `/calls` with per-call detail pages.

**🌙 UI** — shadcn/ui on Radix with a dark-first indigo theme, responsive from
phone (bottom tab bar) to desktop (collapsible nav rail), container-query-driven
settings layouts, and a global `prefers-reduced-motion` switch.

**🕐 Background jobs** — two Vercel Cron routes: a nightly account anonymizer
(the soft-delete's second half) and a Cloudinary orphan sweep.

## 🛠 Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Framework | Next.js 16 (App Router) + React 19 | Server components by default; client islands only where needed |
| Auth | Better Auth | Sessions, sign-in, password flows — signup itself is custom |
| Database | Neon Postgres via Drizzle ORM | Schema shared with `server/` through `../db` (`neon-http`, no transactions) |
| Styling | Tailwind CSS 4 + shadcn/ui (Radix) | Primitives in `components/ui/` are CLI-generated — regenerate, don't hand-edit |
| Realtime | socket.io-client | Singleton in `lib/realtime/socket.ts`, cookie-authenticated handshake |
| Media | Cloudinary + sharp | Server-side sniffing and transforms; delivery URLs built client-safe |
| Email | Brevo REST API | Plain `fetch`, no SDK — one checked `send()` that can't fake success |
| Validation | Zod | Schemas in `lib/validation/`, shared verbatim by client and server |

## 🚀 Getting started

**Prerequisites:** Node.js 20+, a Neon Postgres database, and (for full
functionality) Brevo + Cloudinary credentials. The chat/call features also want the
socket server from [`../server`](../server) running beside this app.

```bash
# 1. Install — from the REPO ROOT (web/ imports ../db, and the schema
#    tooling lives in the root package)
npm install

# 2. Configure
cp .env.example web/.env.local   # from the repo root; fill in the web section

# 3. Push the schema to your Neon database (first run only, from the root)
npx drizzle-kit push

# 4. Run
cd web && npm run dev            # http://localhost:3000
```

Missing optional credentials degrade politely rather than crash: no Cloudinary key
means avatar upload answers `503`, no Brevo key means OTP emails answer `502`. The
app builds and every non-media, non-email flow works without either.

| Script | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint (React 19 rules — the hooks-purity rules here have caught real bugs) |

## 🔧 Environment variables

All names and placeholder values live in the root [`.env.example`](../.env.example);
this app reads them from `web/.env.local`. Never commit real values.

| Variable | Required | Purpose |
| --- | :---: | --- |
| `DATABASE_URL` | ✅ | Neon Postgres connection string — must match `server/`'s. |
| `BETTER_AUTH_SECRET` | ✅ | Signs sessions and tokens. Generate with `openssl rand -hex 32`. |
| `BETTER_AUTH_URL` | ✅ | The app's own origin (e.g. `http://localhost:3000`). |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | ✅ | Same origin, for the browser auth client. |
| `BREVO_API_KEY` | ✉️ | Brevo **REST API** key (`xkeysib-…` — not the same-shaped SMTP key, which fails with a misleading 401). |
| `BREVO_FROM_EMAIL` | ✉️ | Sender address — must be verified in the Brevo dashboard. |
| `BREVO_FROM_NAME` | ✉️ | Sender display name. |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | 🖼 | Server-side upload/destroy. A scoped key needs `create` + `read` (and Admin API access for the cron sweep). |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | 🖼 | Client-safe copy for building delivery URLs — the cloud name is not a secret. |
| `NEXT_PUBLIC_SOCKET_URL` | 💬 | Where the browser reaches the socket server in dev (`http://localhost:4000`). |
| `SOCKET_INTERNAL_URL` | 💬 | Server-to-server address of the socket process; in production it also enables the `/socket.io` rewrite in `next.config.ts`. |
| `MEDIA_SIGNING_SECRET` | 💬 | Signs media tokens for chat uploads. **Must be identical in `server/.env`.** |
| `INTERNAL_API_SECRET` | 💬 | Authorizes calls to the socket server's `/internal/events`. **Must be identical in `server/.env`.** |
| `CRON_SECRET` | 🕐 | Authorizes the two `/api/cron/*` routes (fail-closed: unset refuses every request). |
| `TRUSTED_PROXIES` | 🚀 | CIDR list of trusted proxies. **Deploy prerequisite when self-hosting** — without it, IP rate limits trust a client-supplied `x-forwarded-for`. Leave unset locally and on Vercel. |

Legend: ✅ required to boot meaningfully · ✉️ email flows · 🖼 avatars & media ·
💬 chat/calls realtime · 🕐 cron · 🚀 deploy-time.

## 📁 Project structure

```
web/src/
├── app/
│   ├── (auth pages)             login/, signup/  — public
│   ├── (app)/                   session-guarded shell: nav rail + columns
│   │   ├── (messaging)/         chats/, chats/[conversationId]/, u/[username]/, search/
│   │   ├── calls/               call history + calls/[id]/ detail
│   │   ├── settings/            profile, privacy, account, notifications…
│   │   └── call-provider.tsx    the one client island that owns live calls
│   └── api/
│       ├── auth/[...all]/       Better Auth catch-all
│       ├── signup/*             custom OTP-gated signup flow
│       ├── me/*                 own profile, privacy, username, email, avatar, delete
│       ├── users/               [username]/ public profile + search
│       ├── calls/               history feed
│       ├── conversations/*      chat REST (history, media, membership…)
│       └── cron/*               nightly jobs (CRON_SECRET-gated)
│
├── components/
│   ├── ui/                      shadcn primitives — CLI-generated, never hand-edited
│   └── features/                auth/, messaging/, profile/, search/, shell/, call/
│
└── lib/                         grouped by technical role, not feature
    ├── auth/                    Better Auth config, session helpers
    ├── chat/  call/  realtime/  domain queries, stores, socket plumbing
    ├── db/                      the db singleton + the CommonJS drizzle-ops shim
    ├── integrations/            brevo.ts, cloudinary.ts
    ├── validation/              Zod schemas shared client + server
    └── profile/  social/  media/  jobs/  hooks/  …
```

Two house rules worth knowing before adding code (the full set lives in the root
[`CLAUDE.md`](../CLAUDE.md)):

- **Import Drizzle operators from `@/lib/db/drizzle-ops`**, never from
  `drizzle-orm` directly in a `.ts` file — the shim is what holds a dual-package
  type hazard closed.
- **A component moves from `app/` to `components/features/` only when it gains an
  importer outside its route subtree** — and watch for needless `"use client"`
  directives, which silently ship server code to the browser.

## 🧪 Testing

The e2e suite lives in the root [`../tests`](../tests) workspace (Vitest) and drives
this app **and** the socket server together against the real database:

```bash
# terminal 1          # terminal 2            # terminal 3, from the repo root
cd web && npm run dev  cd server && npm run dev  npm test
```

Read [`tests/README.md`](../tests/README.md) first — fixture naming, cleanup rules,
and the contract-pinning specs (REST and socket must emit the identical 18-field
message shape) are all documented there. The full run takes ~4 minutes, serially, on
purpose.

## 🚢 Deployment

Target: **Vercel**, with the socket server on Render — the complete walkthrough is
[`Docs/deployment/deploy.md`](../Docs/deployment/deploy.md). The Vercel-specific
essentials:

- Root Directory is `web`, **with "Include source files outside of the Root
  Directory" enabled** — the app imports `../db`.
- Setting `SOCKET_INTERNAL_URL` activates a `/socket.io/:path*` rewrite so the
  browser reaches Socket.IO on the app's own origin (the session cookie is
  host-only; a cross-site socket URL would arrive cookieless). Through Vercel's
  proxy this means long-polling, accepted deliberately.
- [`vercel.json`](vercel.json) schedules the two nightly cron routes; set
  `CRON_SECRET` in the Vercel env or they refuse every request.
- Leave `TRUSTED_PROXIES` unset on Vercel — it rewrites `x-forwarded-for` itself.

## 📚 Where the real specs live

This README is the map, not the territory. Feature behavior is specified in
[`../Docs`](../Docs) — [`user/auth.md`](../Docs/user/auth.md),
[`user/profile.md`](../Docs/user/profile.md),
[`user/search.md`](../Docs/user/search.md),
[`chat/chat.md`](../Docs/chat/chat.md), and
[`call/call.md`](../Docs/call/call.md) — and the architectural decisions made while
building against them are recorded in the root [`CLAUDE.md`](../CLAUDE.md). When
this README and a spec disagree, the spec wins.
