# ChatSphere — A Chat & Video Calling App You Can Actually Understand

A learning project that builds the **core machinery** behind WhatsApp, Messenger, and Instagram DMs — real-time chat, voice/video calls, presence, friend requests, media sharing, notifications — and nothing else.

Built for **10–20 real users**, not ten million. That constraint is a feature, not an apology. Every "big tech" component we skip is explained in [Chapter 13: Scaling](#13-scaling--what-wed-add-and-exactly-when), so you learn what Redis/Kafka/SFUs *do* and when you'd actually reach for them — without drowning in them today.

> **Who this README is for:** someone who knows a bit of JavaScript and React, has maybe built a to-do app, and wants to understand how real-time apps work under the hood. Every acronym is defined. Every decision explains *why*. Nothing is hand-waved.

---

## Table of Contents

1. [What This Is (and What It Isn't)](#1-what-this-is-and-what-it-isnt)
2. [The User Journey](#2-the-user-journey)
3. [Tech Stack — and Why Each Piece](#3-tech-stack--and-why-each-piece)
4. [Architecture: Two Servers, One Database](#4-architecture-two-servers-one-database)
5. [HTTP vs WebSocket vs WebRTC](#5-http-vs-websocket-vs-webrtc-the-three-transports)
6. [The Data Model](#6-the-data-model)
7. [Setup Guide](#7-setup-guide)
8. [Feature Walkthroughs](#8-feature-walkthroughs)
9. [WebRTC Deep Dive](#9-webrtc-deep-dive)
10. [Project Structure](#10-project-structure)
11. [Testing It Yourself](#11-testing-it-yourself)
12. [Production Checklist](#12-production-checklist)
13. [Scaling — What We'd Add and Exactly When](#13-scaling--what-wed-add-and-exactly-when)
14. [Glossary & Troubleshooting](#14-glossary--troubleshooting)
15. [Learning Path](#15-learning-path)

---

## 1. What This Is (and What It Isn't)

### ✅ What we're building

| Feature | Details |
|---|---|
| **Account creation** | Email, phone number, username, birth date, password |
| **Profile** | Avatar upload, bio, change username, change display name |
| **User search** | Find people by username, like Instagram's search |
| **Friend requests** | Send / accept / reject / cancel — you can only DM friends |
| **1-on-1 chat** | Real-time text messages, delivered instantly |
| **Group chat** | Create groups, add/remove members, admin roles |
| **1-on-1 calls** | Audio and video, peer-to-peer |
| **Group calls** | Audio and video, **hard cap of 4 people** (see [why](#why-only-4-people)) |
| **Media sharing** | Images, videos, files — with size limits |
| **Message history** | Scroll back through old messages, loaded in pages |
| **Presence** | Green dot when online, "last seen 5 minutes ago" when not |
| **Typing indicators** | "Naman is typing…" |
| **Notifications** | Unread badges, toast popups, tab-title blinking, ringtone for calls |

### ❌ What we're deliberately NOT building

- **No feed, no reels, no posts, no stories.** This is a messenger, not a social network.
- **No public profiles.** You search a username, you send a request, that's the whole discovery flow.
- **No message editing or reactions.** Easy to add later; not core to learning.
- **No end-to-end encryption.** It's a genuinely hard cryptography problem and would triple the project size. Messages *are* encrypted in transit (HTTPS/WSS) but readable in your database. Called out honestly in [Chapter 12](#12-production-checklist).
- **No mobile apps.** Web only. The site is responsive, so it works fine in a phone browser.

### The guiding principle

> **Don't build for a million users when you have twenty.**

A million-user chat app needs Redis, message queues, media servers, database replicas, and a team to run it. A twenty-user chat app needs a Postgres database and two Node processes. We build the second one — and *document* the first one — so you understand both.

---

## 2. The User Journey

Here's the whole app, start to finish:

```
1. SIGN UP        →  email, phone, username, birth date, password
                     ↓
2. VERIFY         →  6-digit code (printed to server console in dev)
                     ↓
3. SET UP PROFILE →  upload avatar, write a bio
                     ↓
4. SEARCH         →  type "@naman" in the search bar
                     ↓
5. SEND REQUEST   →  they get a notification
                     ↓
6. THEY ACCEPT    →  you're now friends; a DM conversation is created
                     ↓
7. CHAT           →  text, images, videos — live, no refresh needed
                     ↓
8. CALL           →  click the phone or camera icon; their browser rings
                     ↓
9. GROUPS         →  create a group, add up to 3 friends, chat or call together
```

Every one of those steps is traced end-to-end in [Chapter 8](#8-feature-walkthroughs).

---

## 3. Tech Stack — and Why Each Piece

Two languages, split by workspace: the **frontend is TypeScript**, the **backend is plain JavaScript**. Each workspace owns its own language boundary — nothing in `server/` needs a build/compile step, and nothing in `web/` gives up type safety.

| Layer | Choice | What it does | Why this and not something else |
|---|---|---|---|
| **Frontend language** | TypeScript | JavaScript with type checking | Catches "cannot read property of undefined" *before* you run the code — valuable in the UI where a message object travels through many components. |
| **Backend language** | JavaScript | Plain Node.js, no compile step | The Socket.IO server is small and long-running; skipping TypeScript here keeps `npm run dev` instant with no build step in between. |
| **Frontend + API** | Next.js 16 (App Router) | React pages + server-side API endpoints | One framework for UI *and* backend routes. React Server Components mean your first page load already has data — no loading spinner flash. |
| **Real-time server** | Express + Socket.IO | Keeps a live connection open to every browser | See [Chapter 4](#4-architecture-two-servers-one-database) for why this is separate from Next.js. Socket.IO handles reconnection, rooms, and fallbacks that raw WebSockets don't. |
| **Database** | Neon (serverless Postgres) | Stores users, messages, groups, everything | Hosted Postgres with no server to manage — chat data is deeply relational (users → friendships → conversations → members → messages), and SQL joins are exactly the right tool. MongoDB would make friend-request queries awkward. |
| **ORM** | Drizzle ORM | Type-safe-ish database queries + migrations | Works natively with Neon's HTTP driver (`@neondatabase/serverless`), no codegen step, and the query builder stays close to real SQL. See [`Docs/db-connection.md`](Docs/db-connection.md) for the full setup. |
| **Auth** | Better Auth | Signup, login, sessions, OTP | **Free forever and self-hosted** — user rows live in *your* Postgres. That matters enormously here: username search and friend requests need SQL `JOIN`s against the user table. With a hosted service like Clerk, users live on *their* servers and you'd need webhooks to mirror them into yours — an extra moving part that can silently drift out of sync. |
| **Video/audio** | WebRTC (browser built-in) | Peer-to-peer media streams | It's already in every browser. No library, no server for the media itself. Your video goes *directly* to your friend — it never touches our server. |
| **Media storage** | Cloudinary (free tier) | Stores uploaded images/videos | 25 GB free, automatic image compression and thumbnails, and it works from any host. Storing uploads on the server's own disk breaks the moment you deploy somewhere with a temporary filesystem. |
| **Styling** | Tailwind CSS | Utility classes for styling | Styles live next to the markup, so you're never hunting through CSS files. Fast to iterate. |
| **Dev orchestration** | npm workspaces + concurrently | Runs both servers with one command | `npm run dev` starts everything. No juggling terminals. |

### What we consciously did NOT install

| Not using | What it's for | Why we don't need it at 20 users |
|---|---|---|
| **Redis** | Shared memory between multiple servers | We have *one* server. A plain JavaScript `Map` is our cache and it's faster. |
| **mediasoup / LiveKit (SFU)** | Relays video so 50 people can call | Our cap is 4. Peer-to-peer handles that natively. |
| **Kafka / RabbitMQ** | Message queues between services | We have no services to queue between. |
| **Docker for the app** | Containerizing Next.js and the socket server | Adds a rebuild step to every code change during development. We *do* use Docker for Postgres, because that saves real setup pain. |
| **Kubernetes** | Orchestrating many containers | You have twenty users. Please don't. |
| **Elasticsearch** | Full-text message search | Postgres `ILIKE '%term%'` returns in under a millisecond on 50,000 messages. |

---

## 4. Architecture: Two Servers, One Database

This is **the most important diagram in this README.** If you understand it, everything else follows.

```
                            ┌─────────────────┐
                            │     BROWSER     │
                            │  (React / UI)   │
                            └────────┬────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
      1. HTTP requests       2. WebSocket            3. WebRTC
      (load page, upload,    (live, always-on)       (peer-to-peer
       search, login)                │                video/audio)
              │                      │                      │
              ▼                      ▼                      │
   ┌────────────────────┐  ┌────────────────────┐           │
   │  NEXT.JS  :3000    │  │ SOCKET.IO  :4000   │           │
   │                    │  │                    │           │
   │ • Pages & UI       │  │ • Live messages    │           │
   │ • Login / signup   │  │ • Typing dots      │           │
   │ • Profile edit     │  │ • Online / offline │           │
   │ • User search      │  │ • Notifications    │           │
   │ • Friend requests  │  │ • Call signaling   │           │
   │ • Message history  │  │                    │           │
   │ • File uploads     │  │                    │           │
   └─────────┬──────────┘  └─────────┬──────────┘           │
             │                       │                      │
             └───────────┬───────────┘                      │
                         ▼                                  │
              ┌────────────────────┐                        │
              │   POSTGRESQL       │                        │
              │  (one database,    │                        │
              │   shared by both)  │                        │
              └────────────────────┘                        │
                                                            ▼
                                              ┌──────────────────────┐
                                              │  YOUR FRIEND'S       │
                                              │  BROWSER             │
                                              │  (video flows here   │
                                              │   directly — never   │
                                              │   through a server)  │
                                              └──────────────────────┘
```

### Why two separate servers?

Here's the analogy that makes it click:

> **HTTP is like sending a letter.** You write a request, mail it, get a reply, and the conversation is over. To ask again, you send another letter.
>
> **A WebSocket is like a phone call you never hang up.** The line stays open. Either side can speak at any moment without being asked.

Next.js API routes are **letters**. They run, they respond, they die. Serverless platforms will even kill them after 10 seconds.

But a chat app needs the **phone call** model — the server must be able to push a message to you the instant your friend sends it, without you asking.

You *can* bolt a WebSocket onto Next.js with a custom server. It's the single biggest source of "why doesn't my chat work in production?" questions on Stack Overflow, because the moment you deploy to Vercel or any serverless host, the socket dies.

**So we separate them from day one.** Next.js does what Next.js is great at (rendering pages, handling requests). Socket.IO does what it's great at (staying connected). Both read and write the same Postgres database, so they always agree on reality.

### How does the socket server know who you are?

Good question — and a subtle one. When your browser opens a WebSocket to `:4000`, that server has no idea you're logged in. Logging in happened on `:3000`.

Our solution, in plain terms:

```
1. Browser connects to socket server, and the browser
   automatically sends along its Better Auth session cookie.

2. Socket server takes that cookie and asks Next.js:
   "Hey, GET /api/auth/get-session — who does this cookie belong to?"

3. Next.js checks the session in Postgres and replies:
   { user: { id: "abc123", username: "naman" } }

4. Socket server attaches that user to the connection.
   Every event from this socket is now known to be from Naman.

5. If step 3 returns nothing → reject the connection.
```

**Honest trade-off:** this adds one internal HTTP request per socket connection — maybe 5 milliseconds, once, when you open the app. The alternative is sharing a JWT signing secret between both servers and verifying it locally, which is faster but means two places that both need to get crypto right. At our scale, the simple version wins, and it's about 15 lines of code. This is the *one* deliberately "slow but simple" thing in the system, and now you know it's there.

---

## 5. HTTP vs WebSocket vs WebRTC (The Three Transports)

Beginners often assume "real-time app = WebSockets" and stop there. Actually we use **three different transports**, each for a different job. Knowing which is which is half of understanding this app.

| | **HTTP** | **WebSocket** | **WebRTC** |
|---|---|---|---|
| **Shape** | Ask → answer → done | Always-on two-way pipe | Direct browser ↔ browser |
| **Who starts it** | Always the browser | Either side, any time | Browser, after a handshake |
| **Goes through our server?** | Yes | Yes | **No** — only the setup does |
| **We use it for** | Pages, login, search, history, uploads | Live messages, typing, presence, notifications, call setup | The actual video and audio |
| **Analogy** | Mailing a letter | An open phone line | A private tunnel between two houses |

### A concrete example: sending a message

```
You type "hello" and press Enter
   │
   ├─► WebSocket: browser emits  message:send { text: "hello" }
   │      │
   │      ▼
   │   Socket server saves it to Postgres
   │      │
   │      ▼
   │   Socket server emits  message:new  to everyone in that conversation
   │      │
   │      ▼
   │   Your friend's browser receives it and renders the bubble
   │   (took about 50 milliseconds; nobody refreshed anything)
   │
   └─► Later, your friend reloads the page
          │
          ▼
       HTTP: GET /api/conversations/xyz/messages?limit=30
          │
          ▼
       Next.js reads Postgres, returns the last 30 messages
```

**Notice:** live messages go over WebSocket. Historical messages come over HTTP. Same data, different transport, because they have different needs — one must be instant and pushed, the other is a bulk fetch you asked for.

### And a call:

```
The negotiation ("let's connect, here's my address")  → WebSocket
The actual video and audio                            → WebRTC, peer-to-peer
```

Your video **never touches our server.** That's why a $5 server can host video calls at all — it's only passing tiny text messages to introduce the two browsers, then getting out of the way.

---

## 6. The Data Model

Nine tables. Better Auth creates four of them; we design five.

### Tables Better Auth manages for us

| Table | Purpose |
|---|---|
| `User` | The person (we add extra columns — see below) |
| `Session` | Active logins — one row per logged-in device |
| `Account` | Password hashes and OAuth links |
| `Verification` | OTP codes and email-verification tokens |

### `User` — extended with our profile fields

```prisma
model User {
  // --- Better Auth's own fields ---
  id            String    @id @default(cuid())
  name          String                          // display name, e.g. "Naman Kumar"
  email         String    @unique
  emailVerified Boolean   @default(false)
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // --- Fields we add ---
  username      String    @unique               // "@naman" — what people search
  phoneNumber   String?   @unique
  phoneVerified Boolean   @default(false)
  birthDate     DateTime?
  bio           String?   @db.VarChar(200)
  avatarUrl     String?                         // Cloudinary URL
  isOnline      Boolean   @default(false)       // green dot
  lastSeenAt    DateTime  @default(now())       // "last seen 5m ago"

  // --- Relations ---
  sentRequests     FriendRequest[]      @relation("Sender")
  receivedRequests FriendRequest[]      @relation("Receiver")
  memberships      ConversationMember[]
  messages         Message[]

  @@index([username])
}
```

**Why `username` is separate from `name`:** `name` is your display name and can be anything ("Naman 🚀"). `username` is unique, lowercase, no spaces — it's your address. Instagram works the same way.

### `FriendRequest` — the social graph

```prisma
model FriendRequest {
  id         String        @id @default(cuid())
  senderId   String
  receiverId String
  status     RequestStatus @default(PENDING)   // PENDING | ACCEPTED | REJECTED
  createdAt  DateTime      @default(now())

  sender   User @relation("Sender",   fields: [senderId],   references: [id])
  receiver User @relation("Receiver", fields: [receiverId], references: [id])

  @@unique([senderId, receiverId])   // can't spam the same person twice
  @@index([receiverId, status])      // fast "show my pending requests"
}
```

**Design note:** one table handles both requests *and* friendships. A row with `status: ACCEPTED` **is** the friendship. Two friends have exactly one row between them, whichever direction it was sent.

To find all of someone's friends:

```ts
// Friends = accepted requests where I'm on either side
const friends = await prisma.friendRequest.findMany({
  where: {
    status: 'ACCEPTED',
    OR: [{ senderId: myId }, { receiverId: myId }],
  },
  include: { sender: true, receiver: true },
});
```

That `OR` is slightly awkward, and it's the honest cost of the one-table design. The alternative — writing two rows per friendship (A→B and B→A) — makes reads simpler but means every accept/unfriend must update two rows in sync. We chose the simpler write path.

### `Conversation` + `ConversationMember` — DMs and groups, unified

```prisma
model Conversation {
  id          String           @id @default(cuid())
  type        ConversationType                    // DIRECT | GROUP
  name        String?                             // groups only
  avatarUrl   String?                             // groups only
  createdById String
  createdAt   DateTime         @default(now())
  updatedAt   DateTime         @updatedAt         // bumped on every message

  members  ConversationMember[]
  messages Message[]
  calls    CallLog[]

  @@index([updatedAt])   // sort the sidebar by most-recent
}

model ConversationMember {
  conversationId String
  userId         String
  role           MemberRole @default(MEMBER)   // OWNER | ADMIN | MEMBER
  joinedAt       DateTime   @default(now())
  lastReadAt     DateTime   @default(now())    // ← powers unread badges

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  user         User         @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([conversationId, userId])   // you're in a conversation once
  @@index([userId])                // fast "list all my chats"
}
```

**Why DMs and groups share one table:** a DM is just a group with exactly two members and no name. Using one structure means chat rendering, message sending, and history loading are written *once* instead of twice. This is the single biggest simplification in the whole schema.

### `Message`

```prisma
model Message {
  id             String      @id @default(cuid())
  conversationId String
  senderId       String
  type           MessageType @default(TEXT)   // TEXT | IMAGE | VIDEO | FILE | SYSTEM
  body           String?     @db.Text         // text content
  mediaUrl       String?                      // Cloudinary URL
  mediaMime      String?                      // "image/png"
  mediaSize      Int?                         // bytes
  mediaName      String?                      // original filename
  createdAt      DateTime    @default(now())
  deletedAt      DateTime?                    // soft delete

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
  sender       User         @relation(fields: [senderId], references: [id])

  @@index([conversationId, createdAt])   // ← the most important index in the app
}
```

**That index is doing real work.** Every time you open a chat we run "give me the newest 30 messages in conversation X." Without the index, Postgres scans every message ever sent. With it, the answer is instant. It stays instant at a million messages.

**`SYSTEM` messages** are the grey italic lines: *"Naman added Priya to the group."* Same table, no special case.

**Soft delete:** `deletedAt` marks a message as deleted without removing the row, so "This message was deleted" can render in place. Real deletion is a cleanup job you'd add later.

### `CallLog`

```prisma
model CallLog {
  id             String     @id @default(cuid())
  conversationId String
  startedById    String
  kind           CallKind                    // AUDIO | VIDEO
  status         CallStatus @default(RINGING) // RINGING | ONGOING | ENDED | MISSED | REJECTED
  startedAt      DateTime   @default(now())
  endedAt        DateTime?
  participantIds String[]

  conversation Conversation @relation(fields: [conversationId], references: [id], onDelete: Cascade)
}
```

This is what renders *"📞 Missed video call · 2:14 PM"* in the chat history.

### Two simplifications we made on purpose

**1. Unread counts come from `lastReadAt`, not read receipts.**

The "proper" design is a `MessageRead` table with one row per message per person. In a 4-person group, 100 messages generates 400 rows.

We store a single timestamp per member instead:

```ts
const unread = await prisma.message.count({
  where: {
    conversationId,
    createdAt: { gt: member.lastReadAt },
    senderId:  { not: myId },
  },
});
```

- **You gain:** an entire table you never have to write, index, or clean up.
- **You lose:** per-person "seen by" ticks in groups. You know *how many* you haven't read, not exactly who read what.
- **When you'd upgrade:** the day someone asks for WhatsApp-style blue ticks in groups.

**2. No message search index.**

`WHERE body ILIKE '%pizza%'` scans the table. On 50,000 messages that's about a millisecond. Postgres full-text search (`tsvector` + GIN index) is the upgrade, and it's worth it somewhere around a million messages. Documented in [Chapter 13](#13-scaling--what-wed-add-and-exactly-when), not built.

---

## 7. Setup Guide

### Prerequisites

| Tool | Version | Check with | If missing |
|---|---|---|---|
| Node.js | 20+ | `node -v` | [nodejs.org](https://nodejs.org) |
| Git | any | `git --version` | [git-scm.com](https://git-scm.com) |

The database is hosted on [Neon](https://neon.tech) (free tier, serverless Postgres) — nothing to install or run locally for it.

### Step 1 — Install dependencies

```bash
cd webRtc_Project
npm install
```

This installs for the root, `web/`, and `server/` all at once (npm workspaces).

### Step 2 — Create your Neon database

1. Sign up at [neon.tech](https://neon.tech) — free tier, no card needed
2. Create a project, then copy the connection string from the dashboard
3. Full walkthrough (schema, Drizzle setup, first query) is in [`Docs/db-connection.md`](Docs/db-connection.md)

### Step 3 — Get your Cloudinary keys (free, 2 minutes)

1. Sign up at [cloudinary.com](https://cloudinary.com) — free tier, no card needed
2. On the dashboard you'll see **Cloud Name**, **API Key**, **API Secret**
3. Keep that tab open for the next step

### Step 4 — Environment variables

Create `.env` at the project root:

```bash
# --- Database (Neon — from Step 2) ---
DATABASE_URL="postgresql://user:password@ep-xxxx.region.aws.neon.tech/dbname?sslmode=require"

# --- Better Auth ---
# Generate a secret with:  openssl rand -base64 32
BETTER_AUTH_SECRET="paste-your-random-string-here"
BETTER_AUTH_URL="http://localhost:3000"

# --- Servers ---
NEXT_PUBLIC_SOCKET_URL="http://localhost:4000"
SOCKET_PORT=4000

# --- Cloudinary (from Step 3) ---
CLOUDINARY_CLOUD_NAME="your-cloud-name"
CLOUDINARY_API_KEY="your-api-key"
CLOUDINARY_API_SECRET="your-api-secret"
```

> ⚠️ **`.env` is in `.gitignore` and must stay there.** Anything prefixed `NEXT_PUBLIC_` is visible in the browser — never put a secret behind that prefix.

### Step 5 — Create the database tables

```bash
npx drizzle-kit push
```

Expected output:
```
Changes applied
```

Step-by-step explanation of what this does (and the schema behind it) lives in [`Docs/db-connection.md`](Docs/db-connection.md).

### Step 6 — Run it

```bash
npm run dev
```

Expected output:
```
[web]    ▲ Next.js 16 — Local: http://localhost:3000
[server] 🔌 Socket.IO listening on :4000
[server] ✅ Connected to Postgres
```

Open **http://localhost:3000** and create your first account.

### Useful commands

```bash
npm run dev              # both servers
npm run dev:web          # just Next.js
npm run dev:server       # just Socket.IO
npx drizzle-kit studio   # visual database browser — use this constantly
npx drizzle-kit push     # sync db/schema.js → Neon after any schema change
npm run typecheck        # tsc --noEmit in web/ only (server/ is plain JS)
```

**`npx drizzle-kit studio` is your best debugging friend.** When something's wrong, open it and look at the actual rows.

---

## 8. Feature Walkthroughs

Each of these traces a feature from click to database and back.

### 8.1 Signup and Login

```
User fills the form: email, phone, username, birth date, password
   │
   ▼
Client-side check: username is 3–20 chars, a–z 0–9 _ only
   │
   ▼
POST /api/auth/sign-up/email    (Better Auth handles this route)
   │
   ├─► Password hashed (scrypt) → stored in Account table
   ├─► User row created with username, phone, birthDate
   ├─► 6-digit OTP generated → stored in Verification
   └─► OTP printed to the server console  ← see note below
   │
   ▼
User types the code → POST /api/auth/verify → emailVerified = true
   │
   ▼
Session row created; signed cookie set (httpOnly, sameSite=lax)
   │
   ▼
Redirect to /onboarding — upload an avatar, write a bio
```

> **About the OTP:** in development the code prints to your terminal instead of being emailed or texted. That's a deliberate choice — no Twilio bill, no SendGrid account, nothing to configure. The code that "sends" it is one function in `web/src/lib/auth.ts`:
> ```ts
> async function sendOTP(to: string, code: string) {
>   console.log(`\n📨 OTP for ${to}: ${code}\n`);
>   // Production: swap this line for Resend / Twilio / your SMTP
> }
> ```
> Replacing that one function with a real sender is genuinely all it takes.

**Why usernames are stored lowercase:** so `@Naman` and `@naman` can't both exist. We lowercase on write, and search lowercases the query too.

### 8.2 Search and Friend Requests

```
You type "nam" in the search bar
   │
   ▼  (debounced 300ms — don't fire a request per keystroke)
GET /api/users/search?q=nam
   │
   ▼
SELECT id, username, name, avatarUrl FROM "User"
WHERE username ILIKE 'nam%' AND id != me
LIMIT 10
   │
   ▼
For each result, work out our relationship:
   • already friends       → show "Message"
   • request sent by me    → show "Requested" (disabled)
   • request sent to me    → show "Accept"
   • no relationship       → show "Add Friend"
   │
   ▼
You click Add Friend → POST /api/friends/request { userId }
   │
   ├─► FriendRequest row created with status PENDING
   └─► Socket server emits notify:friend-request to user:<theirId>
   │
   ▼
Their browser (if open) shows a toast + a badge on the Requests tab
   │
   ▼
They click Accept → POST /api/friends/accept
   │
   ├─► status → ACCEPTED
   ├─► A DIRECT Conversation is created
   ├─► Two ConversationMember rows inserted
   └─► Both users get notified; the chat appears in both sidebars
```

**Why `ILIKE 'nam%'` and not `'%nam%'`:** the prefix version can use an index; the wrap-around version can't. Instagram behaves the same way — searching "naman" won't surface "supernaman". If you want infix matching later, that's a `pg_trgm` index.

### 8.3 Sending a Message

```
You type and press Enter
   │
   ▼
OPTIMISTIC UPDATE: the bubble appears instantly with a ⏱ clock icon
   (using a temporary client-side id)
   │
   ▼
socket.emit('message:send', { conversationId, text, tempId })
   │
   ▼
SERVER:
   1. Is this socket authenticated?              → else reject
   2. Is this user a member of that conversation? → else reject
   3. Is the text 1–4000 chars?                   → else reject
   4. Rate limit: max 30 messages / 10 seconds    → else reject
   5. INSERT the Message row
   6. UPDATE conversation.updatedAt (bumps it up the sidebar)
   │
   ▼
io.to('conversation:<id>').emit('message:new', savedMessage)
   │
   ├─► Your browser: match tempId → replace clock with ✓
   └─► Their browser: render the new bubble, play a soft ping
```

**Why the optimistic update matters:** without it, there's a visible 50–100ms lag between pressing Enter and seeing your own message. That tiny delay is the difference between an app that feels "snappy" and one that feels "laggy." Every serious chat app does this.

**Step 2 is not optional.** Without the membership check, anyone who knows a conversation ID could post into a stranger's chat. Never trust the client's claim about which room it's in.

### 8.4 Online Status and Last Seen

```
SOCKET CONNECTS
   → UPDATE User SET isOnline = true
   → socket.join('user:<myId>')
   → for each conversation I'm in: socket.join('conversation:<id>')
   → broadcast presence:online to my friends

SOCKET DISCONNECTS  (tab closed, network dropped, laptop slept)
   → UPDATE User SET isOnline = false, lastSeenAt = now()
   → broadcast presence:offline to my friends
```

**The multi-tab problem:** if you have the app open in two tabs and close one, `disconnect` fires — but you're still online in the other tab.

The fix is a small in-memory counter:

```ts
// One entry per user; the Set holds their socket ids
const online = new Map<string, Set<string>>();

function onConnect(userId: string, socketId: string) {
  if (!online.has(userId)) {
    online.set(userId, new Set());
    markOnline(userId);            // first tab → they're now online
  }
  online.get(userId)!.add(socketId);
}

function onDisconnect(userId: string, socketId: string) {
  const sockets = online.get(userId);
  sockets?.delete(socketId);
  if (sockets?.size === 0) {
    online.delete(userId);
    markOffline(userId);           // last tab closed → now offline
  }
}
```

> 📌 **Remember this `Map`.** It only works because we have exactly one server. Two servers would each have their own half-empty copy and presence would be wrong. **This is precisely the problem Redis solves** — see [Chapter 13](#13-scaling--what-wed-add-and-exactly-when). At 20 users on one server, the Map is correct *and* faster.

**Typing indicators** work the same way, minus the database:

```
You type → socket.emit('typing:start') → broadcast to the room
You stop for 2 seconds → socket.emit('typing:stop')
```

Typing state is never saved. It's meaningless one second later.

### 8.5 Sending Media

```
You pick a file
   │
   ▼
CLIENT CHECK: type allowed? under the size limit?
   (this is only for a friendly error message — see below)
   │
   ▼
POST /api/upload   (multipart form data)
   │
   ▼
SERVER CHECK — the one that actually counts:
   1. Logged in?
   2. Real MIME type? (sniff the file's magic bytes, don't trust
      the filename — anyone can rename evil.exe to cat.png)
   3. Under the limit? images 5MB · videos 20MB · files 10MB
   4. Rate limit: 10 uploads per minute
   │
   ▼
Stream to Cloudinary → get back a permanent URL
   │
   ▼
Return { url, mime, size } to the browser
   │
   ▼
socket.emit('message:send', { type: 'IMAGE', mediaUrl, ... })
   │
   ▼
Message row saved with mediaUrl; everyone in the chat sees it
```

**Why the server must re-check everything the client checked:** the client check is a *courtesy*. It gives you an instant "that file's too big" instead of a slow upload that fails. But anyone can open DevTools and call the API directly, skipping your UI entirely. **The server check is the real one.** This is true of every validation in every web app you will ever build.

The rate limiter is deliberately unsophisticated:

```ts
const uploads = new Map<string, number[]>();   // userId → timestamps

function checkRateLimit(userId: string) {
  const now = Date.now();
  const recent = (uploads.get(userId) ?? []).filter(t => now - t < 60_000);
  if (recent.length >= 10) throw new Error('Slow down — 10 uploads per minute');
  recent.push(now);
  uploads.set(userId, recent);
}
```

> 📌 **This `Map` is the canonical "here's where Redis would go."** With two servers, a user could do 10 uploads on each and get 20. With one server, this is exact — and it's a dependency you didn't install.

### 8.6 Notifications

Four layers, all free, no service worker, no permission prompt:

| Layer | What it does | How |
|---|---|---|
| **Unread badge** | Red number on the chat in your sidebar | `COUNT(*) WHERE createdAt > lastReadAt` |
| **Toast** | Slide-in popup when you're on another chat | Socket event → toast component |
| **Tab title** | `(3) ChatSphere` in the browser tab | `document.title` when the tab is hidden |
| **Sound** | Soft ping for messages, ringtone for calls | `new Audio('/sounds/ping.mp3').play()` |

```
Message arrives via socket
   │
   ├── Am I looking at that conversation right now?
   │      YES → just render it, mark as read, no noise
   │      NO  → badge + toast + sound
   │
   └── Is the tab hidden? (document.hidden)
          YES → also update the tab title
```

**Why no OS-level Web Push:** it needs a service worker, VAPID keys, and a permission prompt that most people decline. For a 20-user app where everyone keeps the tab open, in-app notifications cover the real need. Adding Web Push later is a self-contained afternoon of work — noted in [Chapter 13](#13-scaling--what-wed-add-and-exactly-when).

---

## 9. WebRTC Deep Dive

This is the part every tutorial gets vague about, so we're going slow.

### The problem WebRTC solves

You want your video to reach your friend's screen. The obvious approach — upload it to a server, have them download it — means your server pays for every byte of every call. Video is *expensive*: a 720p call is roughly 1.5 Mbps in each direction.

WebRTC instead connects the two browsers **directly**. Your video goes straight to their computer. Your server's only job is to introduce them — and introductions are just a few kilobytes of text.

### The hard part: finding each other

Your laptop's real address is something like `192.168.1.5` — a *private* address that only exists inside your home network. Your friend's laptop is `192.168.0.12` inside *theirs*. Neither can reach the other; both are hidden behind a router doing NAT (Network Address Translation).

**STUN** solves this. A STUN server is a machine on the public internet whose entire job is to answer one question: *"From out here, what does my address look like?"* Your router assigned you a public-facing address and port; STUN tells you what it is. Now you have something you can hand to your friend.

We use Google's free public STUN servers. They handle millions of requests and cost nothing.

```ts
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
```

### A complete call, step by step

**Alice calls Bob:**

```
┌── STEP 1 ── Alice clicks the video button
│   const stream = await navigator.mediaDevices.getUserMedia({
│     video: true, audio: true
│   });
│   → Browser asks permission → Alice allows → her own video appears
│
├── STEP 2 ── Alice tells the server she wants to call
│   socket.emit('call:invite', { to: bobId, kind: 'VIDEO' })
│
├── STEP 3 ── Bob's browser rings
│   Incoming-call modal + ringtone. He has 30 seconds before it's
│   logged as MISSED.
│
├── STEP 4 ── Bob accepts
│   He calls getUserMedia() too, then:
│   socket.emit('call:accept', { to: aliceId })
│
├── STEP 5 ── Both create a peer connection
│   const pc = new RTCPeerConnection(config);
│   stream.getTracks().forEach(t => pc.addTrack(t, stream));
│
├── STEP 6 ── Alice makes an OFFER
│   An "offer" is a text blob (SDP) that says:
│   "I can send VP8 video and Opus audio, here are my codecs."
│
│   const offer = await pc.createOffer();
│   await pc.setLocalDescription(offer);
│   socket.emit('rtc:offer', { to: bobId, offer });
│
├── STEP 7 ── Bob answers
│   await pc.setRemoteDescription(offer);
│   const answer = await pc.createAnswer();
│   await pc.setLocalDescription(answer);
│   socket.emit('rtc:answer', { to: aliceId, answer });
│
├── STEP 8 ── Alice accepts the answer
│   await pc.setRemoteDescription(answer);
│   → Both sides now agree on what they're sending
│
├── STEP 9 ── ICE candidates trickle across
│   Each browser discovers possible network paths one at a time
│   and sends each one over as it's found:
│
│   pc.onicecandidate = (e) => {
│     if (e.candidate) socket.emit('rtc:ice-candidate', {
│       to: peerId, candidate: e.candidate
│     });
│   };
│
│   And on receiving one:
│   await pc.addIceCandidate(candidate);
│
│   They try every path until one works. Usually takes ~1 second.
│
└── STEP 10 ── Connected
    pc.ontrack = (e) => {
      remoteVideoRef.current.srcObject = e.streams[0];
    };
    → Bob's face appears. Media now flows browser-to-browser.
       The server is no longer involved.
```

### Mute and camera-off

Genuinely this simple:

```ts
function toggleMute() {
  stream.getAudioTracks().forEach(t => (t.enabled = !t.enabled));
}

function toggleCamera() {
  stream.getVideoTracks().forEach(t => (t.enabled = !t.enabled));
}
```

Setting `enabled = false` makes the track transmit silence/black. No renegotiation, no new offer. A common beginner mistake is calling `track.stop()` instead — that permanently kills the track and you can't turn it back on without redoing the whole handshake.

### Group calls: mesh

With 3+ people, every pair gets its own peer connection:

```
   3 people = 3 connections        4 people = 6 connections

        Alice                            Alice ─── Bob
        ╱    ╲                            │  ╲   ╱  │
       ╱      ╲                           │    ╳    │
     Bob ──── Carol                       │  ╱   ╲  │
                                       Carol ─── Dave
```

Each person uploads a separate copy of their video to every other person.

**The collision problem:** if Alice and Bob both create an offer at the same instant, both connections break. The fix is a simple deterministic rule:

> **Whoever was already in the room makes the offer to the newcomer.**

New person joins → they wait; everyone already there offers to them. No ambiguity, no collisions, no "perfect negotiation" state machine needed.

### Why only 4 people?

Here's the actual arithmetic, assuming 1.5 Mbps per video stream:

| People | Connections each | Your upload | Your download | Verdict |
|---|---|---|---|---|
| 2 | 1 | 1.5 Mbps | 1.5 Mbps | Fine anywhere |
| 3 | 2 | 3 Mbps | 3 Mbps | Fine |
| **4** | **3** | **4.5 Mbps** | **4.5 Mbps** | **Our limit — OK on decent home internet** |
| 5 | 4 | 6 Mbps | 6 Mbps | Struggling |
| 8 | 7 | **10.5 Mbps** | 10.5 Mbps | Broken on most home connections |

Typical home upload is 5–20 Mbps, and **upload is the bottleneck** — it's usually far smaller than download. At 8 people your laptop is also encoding 7 separate video streams, which will spin up the fan and drain the battery.

The professional fix is an **SFU** (Selective Forwarding Unit) — a media server where you upload **once** and it fans your stream out to everyone. Zoom, Meet, and Discord all work this way. Your upload stays at 1.5 Mbps whether it's 4 people or 40.

We don't build one, because an SFU (mediasoup, LiveKit) is a substantial project on its own and you'd be maintaining a media server for a 20-person app. **The cap of 4 is enforced on the server**, not just hidden in the UI:

```ts
if (room.participants.length >= 4) {
  return socket.emit('call:error', { message: 'Call is full (max 4)' });
}
```

### What about TURN?

Roughly 10–15% of connections **cannot** be made peer-to-peer — strict corporate firewalls, symmetric NAT, some mobile carriers. For those, you need a **TURN** server, which relays the media as a fallback.

TURN costs real money because it carries actual video traffic. For friends on home internet, STUN alone works nearly all the time. If you hit a case where a call won't connect, that's your signal — you can self-host `coturn` on a VPS or use a paid service like Twilio's, and it's purely a config addition:

```ts
iceServers: [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'turn:your-server.com:3478', username: 'user', credential: 'pass' },
]
```

No other code changes.

---

## 10. Project Structure

```
webRtc_Project/
│
├── README.md                    ← you are here
├── package.json                 ← workspaces + `npm run dev`
├── .env                         ← DATABASE_URL (Neon), shared by both workspaces
│
├── db/
│   ├── schema.js                ← the single source of truth for all data (Drizzle, plain JS)
│   └── index.js                 ← the connected `db` client both workspaces import
├── drizzle.config.js            ← tells Drizzle Kit where schema + database are
├── drizzle/                     ← auto-generated SQL migrations, commit these
│
├── types/
│   └── socket.js                ← shared event shapes, documented with JSDoc (see note below)
│
├── web/                         ← NEXT.JS APP, TypeScript (port 3000)
│   └── src/
│       ├── app/
│       │   ├── (auth)/          ← login, signup, verify
│       │   ├── (app)/
│       │   │   ├── chat/[id]/   ← the main chat screen
│       │   │   ├── search/
│       │   │   ├── requests/
│       │   │   └── profile/
│       │   └── api/
│       │       ├── auth/[...all]/     ← Better Auth's catch-all route
│       │       ├── users/search/
│       │       ├── friends/
│       │       ├── conversations/
│       │       └── upload/
│       ├── components/
│       │   ├── chat/            ← MessageList, MessageInput, Bubble
│       │   ├── call/            ← CallModal, VideoGrid, CallControls
│       │   └── ui/              ← Button, Avatar, Toast
│       ├── hooks/
│       │   ├── useSocket.ts     ← one shared socket for the whole app
│       │   ├── useMessages.ts
│       │   ├── usePresence.ts
│       │   └── useWebRTC.ts     ← all the peer-connection logic
│       └── lib/
│           ├── auth.ts          ← Better Auth config
│           └── cloudinary.ts
│
└── server/                      ← SOCKET.IO SERVER, JavaScript (port 4000)
    └── src/
        ├── index.js             ← boot Express + Socket.IO
        ├── auth.js              ← verify the session cookie on handshake
        ├── presence.js          ← the online-users Map
        └── handlers/
            ├── chat.js          ← message:send, typing
            ├── call.js          ← call:invite, rtc:* signaling relay
            └── notify.js        ← notification fan-out
```

**Why `types/socket.js` sits at the root:** both the browser (TypeScript) and the socket server (JavaScript) need to agree on what each event's payload looks like, so an event can never be renamed on one side without the other noticing. Since the backend is plain JS, we can't share a `.ts` file directly — instead we document the shapes with **JSDoc comments** in a `.js` file. TypeScript can read JSDoc types from a `.js` file just like a real `.ts` file, so `web/` still gets full autocomplete and type-checking, while `server/` gets the same file with zero build step:

```js
/**
 * @typedef {Object} MessageSendPayload
 * @property {string} conversationId
 * @property {string} text
 * @property {string} tempId
 */

/**
 * @typedef {Object} CallInvitePayload
 * @property {string} to
 * @property {'AUDIO' | 'VIDEO'} kind
 */

module.exports = {}; // this file only exports types via JSDoc, nothing at runtime
```

In `web/`, importing this file gives full IntelliSense on event payloads. In `server/`, it's just documentation the editor still understands — no compiler needed either side.

---

## 11. Testing It Yourself

No automated test suite — at this scale, manual scripts give you better return on your time. (Adding Vitest + Playwright later is a well-defined afternoon; the structure is already test-friendly.)

### The two-browser test (covers most of the app)

Use a **normal window** and an **incognito window** so you get two separate sessions.

| # | Do this | Should happen |
|---|---|---|
| 1 | Sign up as `alice` and `bob` | Both land on onboarding |
| 2 | Alice searches "bob" | Bob appears with "Add Friend" |
| 3 | Alice sends a request | Bob gets a toast **without refreshing** |
| 4 | Bob accepts | Chat appears in both sidebars |
| 5 | Alice sends "hi" | Appears for Bob in under a second |
| 6 | Alice starts typing | Bob sees "Alice is typing…" |
| 7 | Alice stops for 3s | Indicator disappears |
| 8 | Bob closes his tab | Alice sees Bob go offline |
| 9 | Bob returns | Alice sees the green dot again |
| 10 | Alice sends an image | Renders as an image, not a link |
| 11 | Alice tries a 50MB file | Rejected with a clear message |
| 12 | Alice video-calls Bob | Bob's browser rings |
| 13 | Bob accepts | Both see both faces |
| 14 | Bob mutes | Alice sees the muted icon |
| 15 | Alice hangs up | Both return to chat; call logged in history |
| 16 | Bob scrolls up in a long chat | Older messages load in |
| 17 | Both reload | Everything persisted correctly |

### The four-tab test (group calls)

1. Four accounts, all friends, in one group
2. Everyone joins the call → 4 video tiles each
3. **Open a 5th tab and try to join** → must be rejected with "Call is full (max 4)"
4. One person leaves → their tile disappears for everyone
5. Now the 5th can join

Step 3 is the important one. Check it's rejected **by the server** — try emitting `call:join` from the browser console to confirm the UI isn't the only thing stopping you.

### Also worth checking

```bash
npm run typecheck      # must be clean
npx prisma studio      # eyeball the actual rows after each test run
```

- **Deny camera permission** → you should get a clear error, not a white screen
- **Kill your wifi mid-chat** → socket should auto-reconnect when it's back
- **Two tabs, same account, close one** → should stay online

---

## 12. Production Checklist

None of this is needed for localhost. All of it matters before real people use it.

### Non-negotiable

- [ ] **HTTPS.** Not optional — browsers **block `getUserMedia()` on plain HTTP**. No HTTPS means no camera, means no calls. Caddy gets you a free auto-renewing certificate in three lines.
- [ ] **Real secrets.** Fresh `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), a strong database password. Never reuse dev values.
- [ ] **`.env` never committed.** Verify with `git check-ignore .env`.
- [ ] **Lock down CORS.** The socket server should accept your domain only, not `*`.
- [ ] **Database backups.** `pg_dump` on a nightly cron. Test that a restore actually works — an untested backup is not a backup.
- [ ] **Rate limits on auth routes.** Login and OTP endpoints are the ones that get brute-forced.
- [ ] **Real OTP delivery.** Swap the `console.log` for Resend (3,000 emails/month free) or Twilio.

### Strongly recommended

- [ ] **Error tracking** — Sentry's free tier catches the crashes users never report
- [ ] **A TURN server** — if anyone reports calls that won't connect
- [ ] **Uptime monitoring** — UptimeRobot, free, tells you when you're down
- [ ] **Security headers** — `helmet` on Express, CSP in Next.js
- [ ] **Structured logging** — `pino`, so you can actually search production logs

### A minimal production deployment

One small VPS (Hetzner/DigitalOcean, ~$5/month) running everything:

```yaml
# docker-compose.prod.yml
services:
  postgres:
    image: postgres:18-alpine
    volumes: [pgdata:/var/lib/postgresql/data]
    restart: unless-stopped

  web:
    build: ./web
    environment: [DATABASE_URL, BETTER_AUTH_SECRET, ...]
    restart: unless-stopped

  socket:
    build: ./server
    restart: unless-stopped

  caddy:                      # free automatic HTTPS
    image: caddy:alpine
    ports: ["80:80", "443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile]
    restart: unless-stopped

volumes:
  pgdata:
```

```
# Caddyfile — this is genuinely the whole HTTPS setup
chat.yourdomain.com {
  handle /socket.io/* {
    reverse_proxy socket:4000
  }
  handle {
    reverse_proxy web:3000
  }
}
```

Caddy fetches and renews the certificate automatically. No certbot, no cron job.

### An honest note on privacy

**Messages are stored unencrypted in your database.** They're encrypted *in transit* (HTTPS/WSS), but anyone with database access can read them. That's the same as most apps — Instagram DMs, Slack, Discord all work this way.

WhatsApp and Signal are different: they're **end-to-end encrypted**, meaning even the company can't read your messages. Building that properly requires the Signal Protocol — key exchange, ratcheting, multi-device key sync — and it's a genuinely hard cryptography project that would dwarf this one.

**Tell your users the truth.** Don't claim encryption you don't have.

---

## 13. Scaling — What We'd Add and Exactly When

Everything here is **documented, not built**. This is the chapter that turns "I made a chat app" into "I understand how chat apps scale."

The rule: **each of these solves a problem you don't have yet.** Adding one early costs you complexity forever and buys you nothing today.

### 13.1 Redis — when you go from 1 server to 2

**Breaks first:** the moment you run two Node processes.

Remember the online-users `Map` from [8.4](#84-online-status-and-last-seen)? Each server would have its own copy:

```
Server A: Alice, Bob connected     Server B: Carol, Dave connected

Alice sends a message to Carol.
Server A does io.to('user:carol').emit(...)
→ Server A has never heard of Carol. The message vanishes.
```

**Fix:** the Socket.IO Redis adapter. Servers publish events to Redis; every server relays to its own connected clients.

```ts
import { createAdapter } from '@socket.io/redis-adapter';
io.adapter(createAdapter(pubClient, subClient));
```

- **Trigger:** more than one server process. Also once one server can't hold all your connections (~10,000 sockets on modest hardware).
- **Effort:** an afternoon.
- **Also gives you:** shared rate limiting, a session cache, and presence that survives a restart.

### 13.2 An SFU — when calls need more than ~5 people

**Breaks first:** the mesh bandwidth wall from [Chapter 9](#why-only-4-people).

An SFU means each person uploads **once**; the server fans it out. Upload stays flat regardless of participant count. It can also do simulcast — send low-res to people viewing small tiles.

- **Options:** mediasoup (most control), LiveKit (easiest self-host), Daily/Agora (paid, zero ops)
- **Trigger:** you want 5+ in a call, or users complain about heat/battery in 4-person calls
- **Effort:** **1–2 weeks.** This is a real project. Budget accordingly.
- **Also costs:** a beefy server — video relay is CPU and bandwidth hungry

### 13.3 Object storage + CDN

Cloudinary's free tier is 25 GB. When you outgrow it:

- **S3 / Cloudflare R2** for storage (R2 has no egress fees, which matters a lot for media)
- **CloudFront / Cloudflare** in front, so files serve from a location near each user
- **Presigned uploads** — the browser uploads *directly* to storage, skipping your server entirely. Your server just hands out a signed URL. This is how you stop uploads from eating your app server's bandwidth.
- **Trigger:** >25 GB stored, or slow loads for distant users
- **Effort:** 1–2 days

### 13.4 Database scaling, in the order you'd actually do it

1. **Add indexes** (free, first thing always) — turn on `log_min_duration_statement = 100ms` and index whatever shows up
2. **Connection pooling** with PgBouncer — Postgres handles ~100 connections well; a pooler lets thousands of clients share them
3. **Read replicas** — send history queries to a replica, writes to the primary
4. **Partition the messages table by month** — old partitions can be archived or dropped cheaply
5. **Archive cold messages** to S3 — most people never scroll past a month

- **Trigger:** queries over 100ms, or the messages table past ~10 million rows
- **Effort:** incremental, in that order

### 13.5 Full-text search

`ILIKE` scans. Postgres full-text search doesn't:

```sql
ALTER TABLE "Message" ADD COLUMN search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(body, ''))) STORED;
CREATE INDEX message_search_idx ON "Message" USING GIN (search);
```

That's stemming ("running" matches "run"), ranking, and speed — without a new service. Elasticsearch is the step after that, and you probably never need it.

- **Trigger:** search feeling slow, roughly a million messages
- **Effort:** a few hours for the Postgres version

### 13.6 Web Push notifications

Notifications when the tab is **closed**. Needs a service worker, VAPID keys, and a browser permission prompt.

- **Trigger:** users say they miss messages when the tab isn't open
- **Effort:** an afternoon; free
- **Watch out:** iOS Safari only supports this for installed PWAs

### 13.7 Message queues

Kafka/RabbitMQ/BullMQ decouple "accept the request" from "do the slow thing" — sending emails, transcoding video, generating thumbnails.

- **Trigger:** you have genuinely slow background jobs. **Start with BullMQ** (Redis-based, simple), not Kafka.
- **Effort:** a few days

### 13.8 Everything else, briefly

| Add | When |
|---|---|
| Horizontal scaling + load balancer | One server maxed out (see 13.1 first) |
| Microservices | Your *team* is too big to coordinate on one codebase — a scaling problem about people, not traffic |
| GraphQL | Many clients needing different data shapes |
| Kubernetes | Dozens of services and a team to run it |
| Multi-region | Users on other continents complaining about latency |

### The summary table

| Users | What you actually need |
|---|---|
| **1–100** | **Exactly what's in this repo.** One server, one Postgres. |
| 100–1,000 | Add indexes, monitoring, backups, a CDN |
| 1,000–10,000 | Redis, connection pooling, maybe a second server |
| 10,000–100,000 | Multiple servers, read replicas, an SFU, object storage |
| 100,000+ | Sharding, multi-region, a dedicated infrastructure team |

**You have 20 users.** You are in row one. The other rows exist so you know what they're for.

---

## 14. Glossary & Troubleshooting

### Glossary

| Term | Plain English |
|---|---|
| **API** | A URL your code can call to get or change data |
| **CDN** | Copies of your files kept in cities worldwide, so downloads are fast everywhere |
| **CORS** | Browser rule about which websites may call your API |
| **Debounce** | Wait until someone stops typing before firing the request |
| **E2EE** | End-to-end encryption — even the server can't read the messages |
| **Hash** | One-way scramble. Passwords are stored hashed so a leak doesn't expose them |
| **ICE** | The process of trying every possible network path until one connects |
| **JWT** | A signed token proving who you are, that anyone can verify without a database lookup |
| **Mesh** | Everyone connects directly to everyone. Simple; doesn't scale |
| **Migration** | A versioned file describing a database schema change |
| **NAT** | Your router translating between your private address and one public address |
| **ORM** | Library that lets you query the database with objects instead of SQL strings |
| **Optimistic update** | Show it in the UI immediately, before the server confirms |
| **Peer-to-peer** | Two computers talking directly, no server in the middle |
| **Presigned URL** | A temporary link letting a browser upload straight to cloud storage |
| **SDP** | The text blob describing "here are the codecs and formats I support" |
| **SFU** | Media server: you upload once, it forwards to everyone |
| **Signaling** | Passing setup messages so two browsers can find each other |
| **Socket.IO** | Library wrapping WebSockets with reconnection, rooms, and fallbacks |
| **STUN** | Server that tells you your own public address |
| **TURN** | Relay server for when peer-to-peer is impossible (~10–15% of the time) |
| **WebRTC** | Browser tech for direct audio/video between two people |
| **WebSocket** | A connection that stays open, so the server can push to you |

### Troubleshooting — the ten you will actually hit

**1. `Can't reach database server at localhost:5432`**
Postgres isn't running. `docker compose up -d`, then `docker compose ps` to confirm it says healthy.

**2. Socket won't connect / CORS error in the console**
The socket server's allowed origin doesn't match. Check `NEXT_PUBLIC_SOCKET_URL` in `.env` and the `cors.origin` in `server/src/index.ts`. `localhost` and `127.0.0.1` are *different origins* to a browser — pick one and use it everywhere.

**3. Camera works on localhost, breaks when deployed**
You're on HTTP. `getUserMedia()` requires HTTPS everywhere except localhost. This is a hard browser rule, not a bug. Set up Caddy.

**4. Video call connects but the remote video is black**
Usually one of:
- `ontrack` fired but you never set `srcObject`
- The `<video>` element is missing `autoPlay` and `playsInline`
- Browsers block autoplay with sound — add `muted` to your *own* preview video (you don't need to hear yourself anyway)

**5. `Cannot read properties of null (reading 'srcObject')`**
The ref isn't attached yet. Guard it: `if (videoRef.current) videoRef.current.srcObject = stream;`

**6. Messages arrive twice**
A React `useEffect` registered the socket listener twice (Strict Mode runs effects twice in dev). Always clean up:
```ts
useEffect(() => {
  socket.on('message:new', handler);
  return () => { socket.off('message:new', handler); };  // ← this line
}, []);
```

**7. `Unique constraint failed on the fields: (username)`**
That username is taken. Check availability as they type, and catch Prisma's `P2002` error code for a friendly message.

**8. Prisma types are wrong after a schema change**
Run `npx prisma generate`. If your editor still complains, restart the TypeScript server (VS Code: Cmd/Ctrl+Shift+P → "Restart TS Server").

**9. Online status is stuck on for someone who left**
Their socket didn't fire `disconnect` — a laptop that slept, or a hard network drop. Socket.IO's ping timeout catches this after ~20 seconds. If it's permanently stuck, your disconnect handler probably threw an exception before reaching the database update.

**10. Uploads fail with no clear error**
Check, in order: Cloudinary env vars are set, the file is under the limit, the MIME type is in the allowlist, and — a classic — your form is `multipart/form-data`, not JSON.

---

## 15. Learning Path

Build in this order. Each phase ends with something you can actually click, which keeps you motivated.

| # | Phase | You'll learn | Done when you can… |
|---|---|---|---|
| **0** | Scaffold + Docker + Prisma | Monorepos, migrations, env config | See "hello" from both ports |
| **1** | Auth + profile | Sessions, cookies, password hashing, file upload | Log in and change your bio |
| **2** | Search + friend requests | Indexed queries, relational state machines | Add a friend |
| **3** | 1-on-1 chat | **WebSockets, rooms, optimistic UI, pagination** | Chat live in two browsers |
| **4** | Media messages | Multipart uploads, validation, CDN URLs | Send a photo |
| **5** | Groups | Many-to-many relations, roles, permissions | Chat with 3 people |
| **6** | 1-on-1 calls | **WebRTC, SDP, ICE, STUN** | See your own face twice |
| **7** | Group calls | Mesh topology, its limits | Do a 4-way call |
| **8** | Notification polish | Browser APIs, UX detail | Get pinged from another tab |
| **9** | Hardening | Security, deployment, ops | Hand it to someone else |

### The three phases that teach the most

**Phase 3** is where "web app" becomes "real-time app." The moment a message appears in another browser without a refresh, the mental model clicks.

**Phase 6** is the hardest and most rewarding. WebRTC has a lot of vocabulary, but it's really one handshake repeated. Expect to reread [Chapter 9](#9-webrtc-deep-dive) a few times — that's normal.

**Phase 9** is where you learn what "production" actually means. Everything works on localhost. Making it work for other people, safely, is a genuinely different skill.

### Advice

- **Don't skip ahead.** Phase 6 depends on the socket infrastructure from Phase 3.
- **Use `npx prisma studio` constantly.** Seeing the real rows kills whole categories of confusion.
- **Keep two browsers open the entire time you work.** You'll catch bugs the instant you make them.
- **Read the errors.** WebRTC errors in particular are unusually specific — they tell you which step failed.
- **When stuck on WebRTC**, `console.log(pc.connectionState)` and `pc.iceConnectionState`. They tell you exactly which of the ten steps you're on.

---

## License

MIT. It's a learning project — take it, fork it, break it.

---

**Built to be understood, not to scale.** Every simplification here is a deliberate choice with a documented upgrade path. That's not a shortcut — it's how good engineering actually works: solve the problem you have, and know what you'd do about the one you don't.
# webRTC
