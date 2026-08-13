# Database Connection — Neon + Drizzle Architecture

Every other doc in this repo — [`auth.md`](../user/auth.md), [`profile.md`](../user/profile.md), [`chat.md`](../chat/chat.md), [`search.md`](../user/search.md), [`call.md`](../call/call.md) — assumes a single `db` object already exists and reads/writes through it. This is that object: how the app connects to Postgres, how table definitions are organized across those docs, and how a schema change gets from a JS file into the real database.

**One database, two apps.** `web/` (Next.js, TypeScript) and `server/` (Socket.IO, JavaScript) are separate processes but talk to the same Neon Postgres instance through the same schema — so `db/` lives at the project root, not inside either app.

---

## 1. Tech Stack

| Layer | What we use |
|---|---|
| **Database** | Neon — serverless Postgres, one instance shared by every doc in this repo |
| **Driver** | `@neondatabase/serverless` (`neon-http`) — talks to Neon over HTTP, not a persistent TCP socket |
| **ORM** | Drizzle ORM — typed query builder (`db.select()`, `db.insert()`, …), schema-driven |
| **Schema sync** | Drizzle Kit — CLI-only tool, never imported by the running app; reads the schema and pushes/migrates against Neon |
| **Config loading** | `dotenv` — loads `DATABASE_URL` for both the running app and the Drizzle Kit CLI |

**Already available to build on:** every domain doc (auth/profile/chat/call) declares its own tables assuming this connection and folder layout exist — this doc is what makes `require("../db")` resolve to a real, typed connection for all of them.

---

## 2. The Flow

Two separate paths use the schema: queries at runtime, and pushing schema changes to Neon at design time. Both end up pointed at the exact same table definitions.

```mermaid
flowchart TD
    subgraph Runtime["Runtime — every query"]
        App["web/ or server/ code<br/>const { db } = require('db')"] --> Call["db.select() / .insert() / .update() ..."]
        Call --> Driver["@neondatabase/serverless<br/>neon(DATABASE_URL) — HTTP, not a socket"]
        Driver --> Neon["Neon Postgres"]
        Neon --> Result["Typed rows back,<br/>shaped by the schema"]
    end

    subgraph SchemaSync["Design-time — schema changes"]
        Edit["Edit/add a table in<br/>db/schema/&lt;domain&gt;/*.js"] --> Barrel["Domain barrel re-exports it<br/>db/schema/&lt;domain&gt;/index.js"]
        Barrel --> Root["Root barrel re-exports every domain<br/>db/schema/index.js"]
        Root --> Push["npx drizzle-kit push<br/>(reads drizzle.config.js)"]
        Push --> Diff["Drizzle Kit diffs schema vs.<br/>the live Neon tables"]
        Diff --> Apply["Creates/alters tables to match"]
    end

    Root -.->|"same schema object,<br/>passed into drizzle()"| App

    style Neon fill:#3F4FD1,color:#fff,stroke:none
    style Apply fill:#3F4FD1,color:#fff,stroke:none
```

### Why HTTP, not a persistent connection

`neon-http` opens a connection per query over HTTP instead of holding a long-lived TCP socket open. That's the right trade-off here because both `web/` and `server/` run as regular Node processes making occasional queries, not a connection-pooled backend under constant load — no pool to configure, and it works unchanged if either app ever moves to a serverless/edge runtime where a held-open socket wouldn't survive between invocations anyway.

---

## 3. Where Files Live

```
webRtc_Project/
├── db/
│   ├── index.js                 ← connects once, exports `db` — imported by both apps
│   └── schema/
│       ├── index.js              ← root barrel: re-exports every domain below
│       ├── auth/
│       │   └── index.js          ← user, account, session, verification, pending_registration
│       ├── profile/
│       │   └── index.js          ← social_link, privacy_settings, pending_contact_change
│       ├── chat/
│       │   └── index.js          ← conversation, conversation_member, message
│       └── call/
│           └── index.js          ← call, call_participant
├── drizzle.config.js             ← CLI-only config, points at db/schema/index.js
├── drizzle/                        ← auto-generated SQL migration history (after `drizzle-kit generate`)
├── .env                             ← DATABASE_URL, root-level, gitignored
├── web/                             ← Next.js — imports db/ via a relative path
└── server/                          ← Socket.IO — imports db/ via a relative path
```

`db/schema/` is currently an empty folder — nothing under it is implemented yet. The layout above is the structure every domain doc already assumes (auth.md §3, profile.md §3, chat.md §4, call.md §4); this doc exists to make that assumption explicit before the first schema file is written.

---

## 4. Schema Organization — one barrel per domain

| Domain folder | Tables it owns | Defined in |
|---|---|---|
| `auth/` | `user`, `account`, `session`, `verification`, `pending_registration` | auth.md §3 |
| `profile/` | `social_link`, `privacy_settings`, `pending_contact_change` | profile.md §3 |
| `chat/` | `conversation`, `conversation_member`, `message` | chat.md §4 |
| `call/` | `call`, `call_participant` | call.md §4 |

Each domain's `index.js` is a **barrel** — it just re-exports the table objects defined in that folder. `db/schema/index.js` is a barrel of barrels, re-exporting every domain. `db/index.js` and `drizzle.config.js` only ever import that one root path — neither reaches into a specific domain folder directly, so a new domain (or a reorganized one) never means touching the connection code.

**`user` is the one table every domain reads but only `auth/` owns.** profile.md's fields (`bio`, `avatarPublicId`, …) and chat.md/search.md/call.md's foreign keys all point at the same `user` row defined once in `db/schema/auth/`. Other domains import it from there — a table is never redefined in a second folder just because another doc references it.

---

## 5. Connecting — `db/index.js`

```js
const { drizzle } = require("drizzle-orm/neon-http");
const { neon } = require("@neondatabase/serverless");
const schema = require("./schema");

const sql = neon(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });

module.exports = { db };
```

- `neon(process.env.DATABASE_URL)` — opens the HTTP-based connection described in §2.
- `drizzle(sql, { schema })` — wraps it with Drizzle's query builder, linked to the full re-exported schema object (§4), so every table from every domain is queryable through this one `db`.
- This file runs once per process (module caching) — both `web/` and `server/` import the same `module.exports = { db }`, they just each get their own process's copy of the connection.

---

## 6. Drizzle Kit — syncing schema to Neon

| Command | What it does |
|---|---|
| `npx drizzle-kit push` | Diffs `db/schema/index.js` against the live Neon tables and applies the difference directly — fast, no migration file written |
| `npx drizzle-kit generate` | Writes a reviewable `.sql` file into `drizzle/` describing the change, without touching the database |
| `npx drizzle-kit migrate` | Applies pending `.sql` files from `drizzle/`, in order |
| `npx drizzle-kit studio` | Opens a browser GUI to inspect live tables and rows — the fastest way to confirm a push landed |

`push` is the right tool while the schema is still taking shape and there's no real user data to protect — same reasoning as building the app itself right now. `generate` + `migrate` is the documented upgrade once the database holds data worth not losing: a reviewable file before it's applied, instead of a direct diff-and-apply.

---

## 7. Environment Variable

| Variable | Read by | Shape |
|---|---|---|
| `DATABASE_URL` | `db/index.js` at runtime, and `drizzle.config.js` (via `require("dotenv/config")`) for the CLI | `postgresql://user:password@ep-xxxx.<region>.aws.neon.tech/<db>?sslmode=require` |

Both the running app and the Drizzle Kit CLI read the exact same value — one connection string, two consumers — so whatever `push` applies is guaranteed to be the same database the app queries at runtime, never a staging/prod mismatch hidden in two different configs.

---

## 8. Errors & Failure States

| Scenario | What happens |
|---|---|
| `DATABASE_URL` missing or unset | `neon()` throws at import time — the app fails to boot immediately, not on the first query |
| Schema file edited but `drizzle-kit push` never run | Runtime SQL error ("relation does not exist") the first time that table is queried |
| A domain's table defined but not re-exported from its barrel | Drizzle Kit silently ignores it — no error, the table just never gets created in Neon |
| Two domains accidentally export a table with the same name | Whichever barrel is listed later in `db/schema/index.js` wins silently — a review-time problem, not a runtime error |
| Neon compute suspended (free-tier auto-suspend after inactivity) | First query after idle has extra latency while Neon resumes compute — not an error, just a one-time delay |

---

## 9. Future Work — Not Built Yet

**Switch `push` → `generate` + `migrate`.** Flagged in §6 — the natural trigger is "does this database hold data a bad diff could lose," not a fixed date.

**Seed script.** No `db/seed.js` yet for populating local/dev data — every table is currently populated by hand through the app's own flows (signup, first message, etc.).

**Connection pooling / a pooled driver.** `neon-http` (§2) is a fine fit for the current per-request query pattern; a pooled `neon-serverless` (WebSocket) driver would only be worth the added complexity if either app ever needs to hold a session-scoped transaction open across multiple queries, which nothing here does today.

**Read replicas.** Not needed at this scale — one Neon branch serves both apps; revisit only if read load from `web/` and `server/` combined ever becomes a real bottleneck.
