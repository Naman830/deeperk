# Database Connection — Neon + Drizzle, Step by Step

This document is a full, beginner-friendly guide to connecting our backend (plain **JavaScript**, `server/`) to a **Neon** Postgres database using **Drizzle ORM**. If you've never used Drizzle before, read this top to bottom — nothing is assumed.

---

## Table of Contents

1. [What Each Piece Actually Is](#1-what-each-piece-actually-is)
2. [Get a Neon Database](#2-get-a-neon-database)
3. [Where Files Live](#3-where-files-live)
4. [Install Packages](#4-install-packages)
5. [Environment Variables](#5-environment-variables)
6. [Define a Table (the Schema)](#6-define-a-table-the-schema)
7. [Connect to the Database](#7-connect-to-the-database)
8. [The Drizzle Kit Config](#8-the-drizzle-kit-config)
9. [Push the Schema to Neon](#9-push-the-schema-to-neon)
10. [Use It in Code](#10-use-it-in-code)
11. [Everyday Commands](#11-everyday-commands)
12. [Common Mistakes](#12-common-mistakes)

---

## 1. What Each Piece Actually Is

| Term | Plain English |
|---|---|
| **Neon** | A company that runs Postgres for you, in the cloud. You don't install or manage a database server — you just get a connection string (a URL) and start using it. |
| **Postgres** | The actual database engine — where tables and rows live. Neon *is* Postgres, just hosted for you. |
| **Drizzle ORM** | A JavaScript library that lets you write `db.select().from(users)` instead of raw SQL strings. It turns your JS code into SQL behind the scenes. |
| **Drizzle Kit** | A command-line tool (used only from the terminal, never imported in your app) that reads your table definitions and creates/updates the real tables in Neon. |
| **Schema** | A JS file describing what tables and columns exist. This is your single source of truth — Drizzle Kit reads it to know what to build. |
| **Connection string** | A URL like `postgresql://user:password@host/dbname` — tells your app *where* the database is and *how to log in*. |

**The mental flow:**
```
You write tables in schema.js
        │
        ▼
Drizzle Kit reads schema.js → creates matching tables in Neon
        │
        ▼
Your app code imports "db" → runs queries against those tables
```

---

## 2. Get a Neon Database

1. Go to [neon.tech](https://neon.tech) and sign up (free tier, no card required).
2. Click **Create a project**. Pick a region close to you.
3. Neon creates a database automatically and shows you a **connection string** on the dashboard — it looks like:
   ```
   postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require
   ```
4. Copy it. You'll paste it into `.env` in a moment.

**Why this and not installing Postgres locally?** No install, no version mismatches between your machine and production, and it's already the exact same database you'd deploy with.

---

## 3. Where Files Live

Since **both** `web/` (frontend, TypeScript) and `server/` (backend, JavaScript) read and write the same database, the schema and connection code live once, shared, at the **project root** — not inside `server/` alone.

```
webRtc_Project/
├── db/
│   ├── schema.js        ← your tables, written in plain JS
│   └── index.js          ← the connected "db" object both apps import
├── drizzle.config.js     ← tells Drizzle Kit where schema + database are
├── drizzle/                ← auto-generated SQL migration files (after step 9)
├── .env                    ← DATABASE_URL lives here
├── web/                    ← Next.js, TypeScript
└── server/                 ← Socket.IO server, JavaScript
```

---

## 4. Install Packages

From the project root:

```bash
npm install drizzle-orm @neondatabase/serverless
npm install -D drizzle-kit dotenv
```

What each one does:

| Package | Type | Job |
|---|---|---|
| `drizzle-orm` | runtime | The library your app code actually calls (`db.select()`, `db.insert()`, ...) |
| `@neondatabase/serverless` | runtime | Neon's own driver — talks to the database over HTTP instead of a raw TCP socket. Faster to connect, and works even in places a normal DB connection can't (like edge functions). |
| `drizzle-kit` | dev tool | CLI only. Reads `schema.js`, builds/updates real tables in Neon. Never shipped in your running app. |
| `dotenv` | dev tool | Loads `.env` values so `drizzle.config.js` can read `DATABASE_URL` when you run CLI commands. |

---

## 5. Environment Variables

Create `.env` at the project root:

```bash
cat > .env << 'EOF'
DATABASE_URL="postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require"
EOF
```

Paste in your **real** connection string from the Neon dashboard (step 2). `.env` should already be in `.gitignore` — never commit it.

---

## 6. Define a Table (the Schema)

Create `db/schema.js`:

```js
const { pgTable, text, boolean, timestamp } = require("drizzle-orm/pg-core");

const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  isOnline: boolean("is_online").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

module.exports = { users };
```

**Reading this line by line:**
- `pgTable("users", {...})` — declares a table named `users`, with the columns listed inside `{}`.
- `text("id")` — a text column named `id` in the actual database. The first argument (`"users"`, `"id"`) is always the real Postgres name; the JS variable name (`users`, `id`) is what you use in your code.
- `.primaryKey()`, `.notNull()`, `.unique()`, `.default(...)` — constraints, same meaning as in raw SQL.
- `timestamp("created_at").defaultNow()` — Postgres fills this in automatically when a row is inserted.

You'll add more tables the same way later (`messages`, `conversations`, `friendRequests`, etc. — see the main [README's data model](../README.md#6-the-data-model) for the full list).

---

## 7. Connect to the Database

Create `db/index.js`:

```js
const { drizzle } = require("drizzle-orm/neon-http");
const { neon } = require("@neondatabase/serverless");
const schema = require("./schema");

const sql = neon(process.env.DATABASE_URL);
const db = drizzle(sql, { schema });

module.exports = { db };
```

**What's happening:**
1. `neon(process.env.DATABASE_URL)` — opens a connection to your Neon database using the URL from `.env`.
2. `drizzle(sql, { schema })` — wraps that connection with Drizzle's query builder, and links it to your table definitions so you get autocomplete-friendly queries.
3. `module.exports = { db }` — this `db` object is what every other file in `server/` (and `web/`, since it's TypeScript there but the same package works) will import to actually talk to the database.

---

## 8. The Drizzle Kit Config

Create `drizzle.config.js` at the project root:

```js
require("dotenv/config");
const { defineConfig } = require("drizzle-kit");

module.exports = defineConfig({
  schema: "./db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
```

This file is **only** read by the `drizzle-kit` CLI (never by your running app). It tells the CLI: "here's the schema file, here's the database to sync it to, and here's where to write migration history."

---

## 9. Push the Schema to Neon

```bash
npx drizzle-kit push
```

What happens: Drizzle Kit compares `db/schema.js` against what actually exists in your Neon database, and creates/alters tables so they match. Run this again any time you change `schema.js`.

**Note:** `push` is great for early development — fast, no extra files. Later, once the app is live with real data, you'd switch to `drizzle-kit generate` (writes a reviewable `.sql` migration file) + `drizzle-kit migrate` (applies it) — safer because you can read exactly what will change before it happens.

Check it worked:
```bash
npx drizzle-kit studio
```
Opens a browser UI where you can see the actual tables and rows — the fastest way to confirm everything's connected.

---

## 10. Use It in Code

Anywhere in `server/`:

```js
const { db } = require("../db");
const { users } = require("../db/schema");
const { eq } = require("drizzle-orm");

// Read all users
const allUsers = await db.select().from(users);

// Insert a user
await db.insert(users).values({
  id: "1",
  name: "Naman",
  email: "naman@example.com",
  username: "naman",
});

// Find one user
const [user] = await db
  .select()
  .from(users)
  .where(eq(users.username, "naman"));
```

Same `db` object, same schema — every query is just JavaScript function calls, no SQL strings to get wrong.

---

## 11. Everyday Commands

```bash
npx drizzle-kit push       # sync schema.js → real tables in Neon
npx drizzle-kit studio     # open a GUI to browse/edit rows
```

---

## 12. Common Mistakes

| Symptom | Cause | Fix |
|---|---|---|
| `DATABASE_URL is not defined` | `.env` missing, or `drizzle.config.js` didn't load it | Confirm `.env` exists at root and has `DATABASE_URL=...` |
| Table not found in queries but exists in Neon dashboard | Forgot to run `drizzle-kit push` after editing `schema.js` | Run `npx drizzle-kit push` again |
| `SSL required` error | Connection string missing `?sslmode=require` | Copy the full string from the Neon dashboard, don't retype it |
| Changes to `schema.js` don't show up in the app | Nothing to regenerate — unlike Prisma, there's no build step, but you do still need to `push` for the *database* to catch up | Run `push`, then just restart your app |

---

## Summary

**Neon** = the hosted Postgres database. **Drizzle ORM** = how your JS code talks to it. **Drizzle Kit** = the terminal tool that keeps the real database in sync with `db/schema.js`. One shared `db/` folder at the root means both the JS backend and the TS frontend can hit the same database through the same schema.
