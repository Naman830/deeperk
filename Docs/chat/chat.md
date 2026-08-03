# Chat & Calling — How ChatSphere Talks in Real Time

This document picks up **exactly where [`profile.md`](./profile.md) leaves off.** Auth creates the account, profile maintains it — chat is what two accounts *do together* once they're friends: real-time messages, presence, media, notifications, and peer-to-peer voice/video calls.

**Status:** this is the target architecture — the diagrams and code below are the design to build against, not a description of code that exists yet. `server/src/index.js` today is a bare Express app with no Socket.IO, and none of the tables in [§5](#5-the-chat--call-schema) exist in `db/schema/` yet. Everything here is written the way `auth.md`/`profile.md` describe already-built systems, because that's the clearest way to specify *how it must work* — treat every present-tense sentence as "this is what we're building," not "this already runs."

**Design goal:** the same one auth.md and profile.md share — invisible engineering. A message should feel instant, a call should feel like it just works, and none of the three transports underneath (HTTP, WebSocket, WebRTC) should ever be something the user has to think about.

---

## Table of Contents

1. [Where This Connects to Auth & Profile](#1-where-this-connects-to-auth--profile)
2. [Three Transports, Three Jobs](#2-three-transports-three-jobs)
3. [How the Socket Server Knows Who You Are](#3-how-the-socket-server-knows-who-you-are)
4. [From Friend Request to Conversation](#4-from-friend-request-to-conversation)
5. [The Chat & Call Schema](#5-the-chat--call-schema)
6. [Sending a Message, Step by Step](#6-sending-a-message-step-by-step)
7. [Presence, Typing, and the Multi-Tab Problem](#7-presence-typing-and-the-multi-tab-problem)
8. [Media Messages](#8-media-messages)
9. [Group Chat vs 1:1 — One Table, Not Two](#9-group-chat-vs-11--one-table-not-two)
10. [Notifications — Four Layers](#10-notifications--four-layers)
11. [WebRTC Calling — The Handshake](#11-webrtc-calling--the-handshake)
12. [Group Calls — Mesh Topology and the 4-Person Cap](#12-group-calls--mesh-topology-and-the-4-person-cap)
13. [What We Deliberately Don't Build](#13-what-we-deliberately-dont-build)
14. [Events, Endpoints & Rate Limits](#14-events-endpoints--rate-limits)
15. [Pros and Cons](#15-pros-and-cons)
16. [Launch Checklist](#16-launch-checklist)
17. [Connecting It to the Rest of the Stack](#17-connecting-it-to-the-rest-of-the-stack)

---

## 1. Where This Connects to Auth & Profile

```
  auth.md              →  Session row created, httpOnly cookie set
        │
  profile.md §6         →  Privacy tab: discoverable · friendRequests ·
        │                  onlineStatus · profileDetails toggles
        ▼
  chat.md §4            →  Search → friend request → ACCEPTED →
        │                  a Conversation is born
        ▼
  chat.md §6–12          →  Messages, presence, media, calls — all of it
                            gated by the same Session row from auth.md
```

**Three rules inherited from auth.md/profile.md that chat does not get to break:**

| Rule | Where it comes from | What it means here |
|---|---|---|
| Sessions, not JWTs — revoke by deleting a row | auth.md §7 | The socket handshake reads the exact same `session` table; deleting a row disconnects the chat socket in the same instant it kills the web session |
| Privacy toggles are enforced server-side, never just hidden in the UI | profile.md §6 | `onlineStatus` and `discoverable` gate what presence events and search results a socket ever receives — not just what the client chooses to render |
| An unverified `phoneNumber` grants nothing | auth.md §4, profile.md §5 | Chat never uses phone for anything — not for finding friends, not for calls. Discovery is username search only |

> **The seam in one sentence:** auth.md proves who you are once, at login. Every socket event and every call after that trusts `socket.data.userId` — the value read from the database at handshake — never a value the client claims in a payload.

---

## 2. Three Transports, Three Jobs

A chat-and-calling app is not "just WebSockets." Three different transports carry three different kinds of traffic, and mixing them up is the single most common design mistake in tutorials.

| | HTTP | WebSocket (Socket.IO) | WebRTC |
|---|---|---|---|
| **Shape** | Ask → answer → done | Always-on, two-way pipe | Direct browser ↔ browser |
| **Runs through our server?** | Yes | Yes | **No** — only the handshake does |
| **We use it for** | Message history (paged), conversation list, friend requests, media upload | Live messages, typing, presence, notifications, call signaling | The actual audio/video |
| **Port** | `:3000` (Next.js) | `:4000` (Socket.IO) | N/A — peer to peer |

**Why a separate Socket.IO server, not a WebSocket bolted onto Next.js:** Next.js API routes are request/response — they run, they reply, they die, and serverless hosts will kill a long-lived connection after ~10 seconds. A chat app needs the opposite: a connection the server can push through the instant a friend sends something, without being asked. So `server/` (port `:4000`) is a plain, always-running Node process whose only job is staying connected. Both processes read and write the **same** Postgres database (auth.md §14.2), so they always agree on reality — there's no second copy of a message or a session to drift out of sync.

**The same message, two transports, on purpose:**

```
Live delivery         →  socket.emit('message:send', ...) → 'message:new' pushed to the room
Scrolling up for more  →  GET /api/conversations/:id/messages?before=<cursor>&limit=30
```

One is instant and pushed; the other is a bulk fetch you asked for. Same `message` table underneath, different transport because the two have different jobs.

---

## 3. How the Socket Server Knows Who You Are

When a browser opens a WebSocket to `:4000`, that process has no built-in notion of "logged in" — the login happened on `:3000`. But `server/` and `web/` share the exact same Postgres connection (auth.md §14.7), so the socket server doesn't need to ask Next.js anything — it reads the `session` table directly, the same table Better Auth writes to:

```
Browser opens the WebSocket
      │  (browser attaches the session cookie automatically — same-domain, so this is free)
      ▼
Socket.IO handshake middleware (:4000)
      │
      ├─ parse the session cookie
      ├─ SELECT * FROM session WHERE token = ... AND expires_at > NOW()
      │
      ├─ no valid row  →  reject the connection
      └─ valid row     →  socket.data.userId = session.userId
                          socket.join(`user:${userId}`)
                          for each conversation this user is in: socket.join(`conversation:${id}`)
```

```js
// server/src/auth.js
const { db } = require("../../db");
const { session } = require("../../db/schema");
const { eq, and, gt } = require("drizzle-orm");

async function authenticateSocket(cookieToken) {
  const [row] = await db
    .select()
    .from(session)
    .where(and(eq(session.token, cookieToken), gt(session.expiresAt, new Date())));
  return row ?? null;
}

module.exports = { authenticateSocket };
```

Two consequences worth naming, both inherited straight from auth.md §7:

- **Every socket event is trusted.** `socket.data.userId` came from a database row, not from the client. A payload claiming `{ from: "someone-else" }` is ignored outright — handlers use `socket.data.userId`, always. This is the single most important rule in the socket server, repeated from auth.md because it matters exactly as much here.
- **Revocation reaches sockets instantly.** Delete a `session` row (password change, "log out everywhere," a device you don't recognize) and that device's socket disconnects on its very next check — no separate revocation path to build or forget.

---

## 4. From Friend Request to Conversation

Discovery is intentionally narrow: you search a username, you send a request, someone accepts, a conversation appears. There is no feed, no public browsing of the whole user base — this is a messenger, not a directory.

```
Type "nam" in search
      │  debounced 300ms
      ▼
GET /api/users/search?q=nam
      │
      ├─ SELECT id, username, name, avatarUrl FROM "user"
      │  WHERE username ILIKE 'nam%' AND id != me
      │  AND privacy_settings.discoverable allows it (profile.md §6)
      │
      ▼
For each result, resolve the relationship:
   already friends       → "Message"
   request sent by me    → "Requested" (disabled)
   request sent to me    → "Accept"
   no relationship       → "Add Friend"   (hidden if their friendRequests toggle says NOBODY)
      │
      ▼
POST /api/friends/request { userId }
      │
      ├─ INSERT friend_request { senderId, receiverId, status: PENDING }
      └─ socket server emits notify:friend-request to room `user:<theirId>`
      │
      ▼
POST /api/friends/accept { requestId }
      │
      ├─ status → ACCEPTED
      ├─ INSERT conversation { type: DIRECT }
      ├─ INSERT conversation_member × 2   (both users, role MEMBER)
      └─ both sockets get the new conversation pushed into their sidebar
```

**Why `ILIKE 'nam%'` and not `'%nam%'`:** the prefix form can use the index on `username`; the wrapped form can't. It also means searching "naman" won't surface "supernaman" — the same behavior Instagram's search has.

**One row does double duty.** `friend_request` never gets a separate `friendship` table — a row with `status: ACCEPTED` *is* the friendship. Unfriending is just flipping or deleting that one row, not reconciling two tables.

---

## 5. The Chat & Call Schema

None of these tables exist in `db/schema/` yet. They'd live in a new `db/schema/chat/` folder, following the exact pattern `db/schema/profile/` already established: one file per table, an `index.js` that re-exports them, and `db/schema/index.js` picking that up automatically (`...require("./chat")`, alongside the existing `...require("./auth")` and `...require("./profile")`).

They reference the real `user` table (`db/schema/auth/user.js`) — not a redrawn copy of it. That table already carries `username`, `isOnline`, `lastSeenAt`, `avatarUrl`, `bio` and the rest (auth.md §4); chat tables just point `references(() => user.id)` at it, the same way `db/schema/profile/social-link.js` already does.

### `friend_request` — the social graph

```js
// db/schema/chat/friend-request.js
const { pgTable, text, timestamp, uniqueIndex, index, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

const requestStatus = pgEnum("request_status", ["PENDING", "ACCEPTED", "REJECTED"]);

const friendRequest = pgTable("friend_request", {
  id:         text("id").primaryKey(),
  senderId:   text("sender_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  receiverId: text("receiver_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  status:     requestStatus("status").default("PENDING").notNull(),
  createdAt:  timestamp("created_at").defaultNow().notNull(),
}, (table) => ({
  senderReceiverUnique: uniqueIndex("friend_request_sender_receiver_unique").on(table.senderId, table.receiverId),
  receiverStatusIdx: index("friend_request_receiver_status_idx").on(table.receiverId, table.status),
}));

module.exports = { friendRequest, requestStatus };
```

**Design note:** one table for both the request *and* the friendship. Finding "am I friends with X" is `status = 'ACCEPTED' AND (senderId = me OR receiverId = me)` — a slightly awkward `OR`, and the honest cost of not writing two rows (A→B and B→A) per friendship. The alternative makes reads simpler but means every accept/unfriend has to keep two rows in sync; we chose the simpler write path, same call README made.

### `conversation` + `conversation_member` — DMs and groups, unified

```js
// db/schema/chat/conversation.js
const { pgTable, text, timestamp, index, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

const conversationType = pgEnum("conversation_type", ["DIRECT", "GROUP"]);

const conversation = pgTable("conversation", {
  id:          text("id").primaryKey(),
  type:        conversationType("type").notNull(),
  name:        text("name"),        // groups only
  avatarUrl:   text("avatar_url"),  // groups only
  createdById: text("created_by_id").notNull().references(() => user.id),
  createdAt:   timestamp("created_at").defaultNow().notNull(),
  updatedAt:   timestamp("updated_at").defaultNow().notNull(),   // bumped on every message — sorts the sidebar
}, (table) => ({
  updatedAtIdx: index("conversation_updated_at_idx").on(table.updatedAt),
}));

module.exports = { conversation, conversationType };
```

```js
// db/schema/chat/conversation-member.js
const { pgTable, text, timestamp, primaryKey, index, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("./conversation");

const memberRole = pgEnum("member_role", ["OWNER", "ADMIN", "MEMBER"]);

const conversationMember = pgTable("conversation_member", {
  conversationId: text("conversation_id").notNull().references(() => conversation.id, { onDelete: "cascade" }),
  userId:         text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role:           memberRole("role").default("MEMBER").notNull(),
  joinedAt:       timestamp("joined_at").defaultNow().notNull(),
  lastReadAt:     timestamp("last_read_at").defaultNow().notNull(),   // ← powers unread badges, see §13
}, (table) => ({
  pk: primaryKey({ columns: [table.conversationId, table.userId] }),
  userIdx: index("conversation_member_user_idx").on(table.userId),   // fast "list all my chats"
}));

module.exports = { conversationMember, memberRole };
```

**Why DMs and groups share one structure:** a DM is just a two-member `conversation` with `type: DIRECT` and no name. Message sending, history loading, and unread counting are written **once**, not once for DMs and again for groups — the single biggest simplification in this schema (elaborated in [§9](#9-group-chat-vs-11--one-table-not-two)).

### `message`

```js
// db/schema/chat/message.js
const { pgTable, text, integer, timestamp, index, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("./conversation");

const messageType = pgEnum("message_type", ["TEXT", "IMAGE", "VIDEO", "FILE", "SYSTEM"]);

const message = pgTable("message", {
  id:             text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversation.id, { onDelete: "cascade" }),
  senderId:       text("sender_id").notNull().references(() => user.id),
  type:           messageType("type").default("TEXT").notNull(),
  body:           text("body"),
  mediaUrl:       text("media_url"),
  mediaMime:      text("media_mime"),
  mediaSize:      integer("media_size"),
  mediaName:      text("media_name"),
  createdAt:      timestamp("created_at").defaultNow().notNull(),
  deletedAt:      timestamp("deleted_at"),   // soft delete — see §13
}, (table) => ({
  conversationCreatedIdx: index("message_conversation_created_idx").on(table.conversationId, table.createdAt),
}));

module.exports = { message, messageType };
```

**That composite index is the one that matters most in the whole app.** Opening a chat means "give me the newest 30 messages in conversation X" — without the index that's a full scan of every message ever sent; with it, the answer is instant at any table size. `SYSTEM` messages ("Naman added Priya to the group") use this same table with `type: SYSTEM` — no special-cased log table.

### `call_log`

```js
// db/schema/chat/call-log.js
const { pgTable, text, timestamp, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("./conversation");

const callKind = pgEnum("call_kind", ["AUDIO", "VIDEO"]);
const callStatus = pgEnum("call_status", ["RINGING", "ONGOING", "ENDED", "MISSED", "REJECTED"]);

const callLog = pgTable("call_log", {
  id:             text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversation.id, { onDelete: "cascade" }),
  startedById:    text("started_by_id").notNull().references(() => user.id),
  kind:           callKind("kind").notNull(),
  status:         callStatus("status").default("RINGING").notNull(),
  startedAt:      timestamp("started_at").defaultNow().notNull(),
  endedAt:        timestamp("ended_at"),
  participantIds: text("participant_ids").array().notNull().default([]),
});

module.exports = { callLog, callKind, callStatus };
```

This is what renders `📞 Missed video call · 2:14 PM` inline in the chat history — a call is a first-class row, not something inferred from socket logs.

---

## 6. Sending a Message, Step by Step

```
You type and press Enter
      │
      ▼
OPTIMISTIC UPDATE — the bubble renders instantly with a clock icon,
keyed by a client-generated tempId
      │
      ▼
socket.emit('message:send', { conversationId, text, tempId })
      │
      ▼
SERVER:
   1. Is this socket authenticated?               → else reject   (§3)
   2. Is this userId a member of that conversation? → else reject  ← never trust a client-claimed room
   3. Is the text 1–4000 chars?                    → else reject
   4. Rate limit: 30 messages / 10 seconds per user → else reject
   5. INSERT the message row
   6. UPDATE conversation.updatedAt                 (bumps it up the sidebar)
      │
      ▼
io.to(`conversation:${id}`).emit('message:new', savedMessage)
      │
      ├─ your browser:   match tempId → swap the clock icon for a checkmark
      └─ their browser:  render the new bubble, play a soft ping
```

**Why the optimistic update matters:** without it there's a visible 50–100ms gap between pressing Enter and seeing your own message appear. That gap is the entire difference between an app that feels instant and one that feels laggy.

**Step 2 is not optional.** Without a server-side membership check, anyone who learns a `conversationId` — from a URL, a screenshot, a leaked log line — could post into a conversation they were never added to. The client's claim about which room it's in is never trusted; the server checks `conversation_member` on every single send.

---

## 7. Presence, Typing, and the Multi-Tab Problem

```
SOCKET CONNECTS
   → UPDATE "user" SET is_online = true
   → socket.join(`user:${myId}`)
   → for each conversation I'm in: socket.join(`conversation:${id}`)
   → broadcast presence:online to my friends whose onlineStatus toggle allows it (profile.md §6)

SOCKET DISCONNECTS  (tab closed, network dropped, laptop slept)
   → UPDATE "user" SET is_online = false, last_seen_at = now()
   → broadcast presence:offline
```

**The multi-tab problem:** two tabs open, close one, `disconnect` fires — but the user is still online in the other tab. A plain in-memory counter fixes this, and it only works *because* there's exactly one server process holding it:

```js
// server/src/presence.js
const online = new Map(); // userId → Set<socketId>

function onConnect(userId, socketId) {
  if (!online.has(userId)) {
    online.set(userId, new Set());
    markOnline(userId);          // first tab → genuinely just came online
  }
  online.get(userId).add(socketId);
}

function onDisconnect(userId, socketId) {
  const sockets = online.get(userId);
  sockets?.delete(socketId);
  if (sockets?.size === 0) {
    online.delete(userId);
    markOffline(userId);         // last tab closed → genuinely offline
  }
}

module.exports = { onConnect, onDisconnect };
```

> **This `Map` is exactly where Redis would go with two server processes** ([§13](#13-what-we-deliberately-dont-build)). With one server it's not an approximation — it's correct, and faster than a network round trip would be.

**Typing indicators** reuse none of this state — they're broadcast-only, never written to the database:

```
socket.emit('typing:start')  → broadcast to the conversation room
(2s of silence)
socket.emit('typing:stop')   → broadcast to the conversation room
```

A "typing" state that's a second old is meaningless, so there's nothing to persist and nothing to clean up.

---

## 8. Media Messages

Reuses the exact `/api/upload` pipeline `profile.md` §4 already established for avatars — no second upload path to build or keep in sync.

```
Pick a file
      │
      ▼
CLIENT CHECK: type allowed? under the size limit?          ← a courtesy, not a control
      │
      ▼
POST /api/upload  (multipart)
      │
      ▼
SERVER CHECK — the one that actually counts:
   1. logged in?
   2. real MIME type, sniffed from magic bytes                ← never trust the filename or extension
   3. under the limit: images 5MB · videos 20MB · files 10MB
   4. rate limit: 10 uploads / minute per user
      │
      ▼
Stream to Cloudinary → get back a permanent URL
      │
      ▼
socket.emit('message:send', { type: 'IMAGE', mediaUrl, mediaMime, mediaSize, mediaName })
      │
      ▼
message row saved with the media columns; everyone in the conversation sees it render inline
```

**Why the server re-checks everything the client already checked:** the client check gives an instant "that file's too big" instead of a slow failed upload — pure UX. Anyone can call `/api/upload` directly from DevTools, skipping the UI entirely, so the server check is the only one that's actually a control. Same rule auth.md §9 states for form fields, applied here to files.

---

## 9. Group Chat vs 1:1 — One Table, Not Two

A DM is a `conversation` with `type: DIRECT`, exactly two `conversation_member` rows, and `name = null`. A group is the same table with `type: GROUP`, more members, and a `name`. There is no separate `DirectMessage` model anywhere.

**What this buys:**

- Message sending (§6), history pagination, and unread counting are one code path, not two kept in sync by hand.
- Adding "group calls" ([§12](#12-group-calls--mesh-topology-and-the-4-person-cap)) costs nothing extra in the data model — a call just has `participantIds.length > 2`.
- `memberRole` (`OWNER` / `ADMIN` / `MEMBER`) is meaningless for a 2-person DM and simply goes unused there — cheaper than a schema that only half-applies to half its rows would be to maintain.

**Group-specific actions** (add member, remove member, promote to admin, rename group, change group avatar) each write a `SYSTEM` message into the same `message` table (`type: SYSTEM`, `body: "Naman added Priya to the group"`) so the event shows up inline in history exactly where it happened — no separate audit trail to build for group changes.

---

## 10. Notifications — Four Layers

No Web Push, no service worker, no browser permission prompt — four layers that work with the tab merely open:

| Layer | What it does | How |
|---|---|---|
| **Unread badge** | Red count on the sidebar entry | `COUNT(*) FROM message WHERE conversation_id = ? AND created_at > lastReadAt AND sender_id != me` |
| **Toast** | Slide-in popup when you're looking at a different chat | Socket event → toast component |
| **Tab title** | `(3) ChatSphere` in the browser tab | `document.title` updated while `document.hidden` |
| **Sound** | Soft ping for messages, a ringtone for incoming calls | `new Audio('/sounds/ping.mp3').play()` |

```
message:new arrives
      │
      ├─ am I looking at that conversation right now?
      │      yes → render it, mark as read, no noise
      │      no  → badge + toast + sound
      │
      └─ is the tab hidden (document.hidden)?
             yes → also update the tab title
```

`notify:friend-request` and `call:invite` follow the identical badge/toast/sound pattern — one mental model covers every kind of interruption in the app, not three different notification systems.

---

## 11. WebRTC Calling — The Handshake

The socket server's *only* job in a call is introducing two browsers to each other. Once connected, video and audio flow **directly between the two peers** — it never touches our server, which is why a $5 server can host calls at all.

### The hard part: finding each other

Both laptops sit behind a router doing NAT, so their real addresses (`192.168.x.x`) only exist inside their own home networks. **STUN** is a public server whose only job is answering "from out here, what does my public-facing address look like?" We use Google's free public STUN servers — no self-hosting needed:

```ts
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};
```

### A complete call, Alice → Bob

```
1. Alice clicks the video button
   const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
   → her own video appears

2. Alice tells the server she wants to call
   socket.emit('call:invite', { to: bobId, kind: 'VIDEO' })

3. Bob's browser rings — incoming-call modal + ringtone.
   30 seconds to answer, or the call logs as MISSED (call_log.status)

4. Bob accepts
   his own getUserMedia() runs, then
   socket.emit('call:accept', { to: aliceId })

5. Both sides create a peer connection
   const pc = new RTCPeerConnection(config)
   stream.getTracks().forEach(t => pc.addTrack(t, stream))

6. Alice makes an OFFER — an SDP text blob: "here are my codecs"
   const offer = await pc.createOffer()
   await pc.setLocalDescription(offer)
   socket.emit('rtc:offer', { to: bobId, offer })

7. Bob answers
   await pc.setRemoteDescription(offer)
   const answer = await pc.createAnswer()
   await pc.setLocalDescription(answer)
   socket.emit('rtc:answer', { to: aliceId, answer })

8. Alice accepts the answer — both sides now agree on the media contract
   await pc.setRemoteDescription(answer)

9. ICE candidates trickle across as each browser discovers network paths
   pc.onicecandidate = (e) => e.candidate &&
     socket.emit('rtc:ice-candidate', { to: peerId, candidate: e.candidate })
   // on receiving one:
   await pc.addIceCandidate(candidate)

10. Connected
    pc.ontrack = (e) => { remoteVideoRef.current.srcObject = e.streams[0] }
    → Bob's face appears. The server is no longer involved in the media at all.
```

**Mute and camera-off:**

```ts
function toggleMute()   { stream.getAudioTracks().forEach(t => (t.enabled = !t.enabled)); }
function toggleCamera() { stream.getVideoTracks().forEach(t => (t.enabled = !t.enabled)); }
```

Setting `enabled = false` transmits silence/black with no renegotiation. The common mistake is calling `track.stop()` instead — that permanently kills the track and turning it back on requires redoing the whole handshake.

**Voice calls and video calls are one code path**, not two systems: a call is `kind: 'AUDIO' | 'VIDEO'` on the same invite/`call_log` row. An audio-only call simply never adds a video track and never renders the `<video>` element — nothing about the signaling changes.

---

## 12. Group Calls — Mesh Topology and the 4-Person Cap

With 3+ participants, every pair gets its **own** `RTCPeerConnection` — a mesh, not a hub. 4 people means 6 connections total, and each person uploads a separate copy of their own stream to every other participant.

**The collision problem:** if two people both try to send the first offer at the same instant, both connections break. The fix is a deterministic rule with no negotiation state machine required: **whoever was already in the room offers to the newcomer.** A new joiner waits; everyone already present initiates toward them.

**Why the cap is 4, with the actual arithmetic** (at ~1.5 Mbps per video stream):

| People | Connections each | Your upload | Verdict |
|---|---|---|---|
| 2 | 1 | 1.5 Mbps | Fine anywhere |
| 3 | 2 | 3 Mbps | Fine |
| **4** | **3** | **4.5 Mbps** | **Our limit — fine on typical home upload** |
| 5 | 4 | 6 Mbps | Struggling |
| 8 | 7 | 10.5 Mbps | Broken on most home connections |

Home upload bandwidth is usually the bottleneck (often far smaller than download), and past 4 people a laptop is also encoding several outbound video streams at once — fans spin up, batteries drain. The cap is enforced **server-side**, not just hidden in the UI, because a client can always lie about which button it clicked:

```js
// server/src/handlers/call.js
if (room.participants.length >= 4) {
  return socket.emit('call:error', { message: 'Call is full (max 4)' });
}
```

The professional fix past this point is an **SFU** (Selective Forwarding Unit) — you upload once, the server fans it out to everyone, and your upload stays flat regardless of participant count. Deliberately not built here; see [§13](#13-what-we-deliberately-dont-build).

---

## 13. What We Deliberately Don't Build

Every omission below is a documented trade-off with a real upgrade path, not an oversight — the same honesty auth.md and profile.md apply to their own limitations.

| Skipped | Why | What we do instead | Upgrade trigger |
|---|---|---|---|
| **End-to-end encryption** | Real E2EE (the Signal Protocol — key exchange, ratcheting, multi-device key sync) is a hard cryptography project on its own, easily bigger than the rest of this app combined | Messages are encrypted **in transit** (HTTPS/WSS) but stored as plaintext in Postgres — the same model Slack, Discord, and Instagram DMs use. This is told to users honestly, never implied to be more than it is | Never casually — this is a from-scratch redesign, not an incremental add |
| **Per-message read receipts** | A `MessageRead` row per message per person explodes fast: 100 messages in a 4-person group is 400 rows | A single `lastReadAt` timestamp per `conversation_member` ([§5](#5-the-chat--call-schema)); unread count is `COUNT(*) WHERE createdAt > lastReadAt`. You know *how many* you haven't read, not exactly who's seen which message in a group | The day someone specifically wants WhatsApp-style blue ticks in groups |
| **Message editing & reactions** | Not core to learning the real-time machinery; meaningfully more schema and UI for something that doesn't teach anything new | Soft delete only — `message.deletedAt` renders "This message was deleted" in place, the row stays for the sake of everyone else's thread | Whenever product scope actually asks for it — it's additive, not a redesign |
| **SFU for group calls** | mediasoup/LiveKit is a substantial media-server project on its own, with real infrastructure to run and pay for | Mesh topology, hard-capped at 4 participants, enforced server-side ([§12](#12-group-calls--mesh-topology-and-the-4-person-cap)) | Wanting 5+ people in a call, or users complaining about heat/battery at 4 |
| **A self-hosted TURN server by default** | TURN relays actual media traffic, so it costs real bandwidth money continuously, not just at setup | STUN only (free, Google's public servers). ~85–90% of home-network calls connect fine without TURN | The first real report of a call that won't connect — add `coturn` or a paid TURN provider as pure config, no code changes |
| **Full-text message search** | Elasticsearch is a service to run, monitor, and keep in sync for a feature `ILIKE` already handles at this scale | `WHERE body ILIKE '%term%'` — a few hundred microseconds even at tens of thousands of messages | Search starts feeling slow, roughly in the low millions of messages — the upgrade is a Postgres `tsvector` + GIN index, still no new service |
| **Redis-backed presence across multiple servers** | We run exactly one Socket.IO process; a `Map` in memory is correct and faster than any network round trip would be | The in-memory `online` `Map` from [§7](#7-presence-typing-and-the-multi-tab-problem) | The moment a second server process exists — the online-users state and any per-user rate limiter both need to live in Redis instead, or presence silently goes wrong per the split traffic |

---

## 14. Events, Endpoints & Rate Limits

### Socket events

| Event | Direction | Payload | Persisted? |
|---|---|---|---|
| `message:send` | client → server | `{ conversationId, text, tempId }` | Yes → `message` |
| `message:new` | server → room | full saved message row | — |
| `typing:start` / `typing:stop` | client ↔ room | `{ conversationId }` | Never |
| `presence:online` / `presence:offline` | server → friends | `{ userId }` | `user.isOnline`, `lastSeenAt` |
| `notify:friend-request` | server → `user:<id>` | `{ fromUserId }` | Already in `friend_request` |
| `call:invite` | client → server | `{ to, kind }` | `call_log` (RINGING) |
| `call:accept` | client → server | `{ to }` | `call_log` → ONGOING |
| `call:join` | client → server | `{ roomId }` | server-enforced 4-cap, §12 |
| `rtc:offer` / `rtc:answer` / `rtc:ice-candidate` | peer → peer, relayed | SDP / ICE candidate | Never — pure signaling relay |
| `call:error` | server → client | `{ message }` | — |

### REST endpoints

| Route | Does | Rate limit |
|---|---|---|
| `GET /api/users/search?q=` | Prefix username search, privacy-filtered | 30/min per IP |
| `POST /api/friends/request` | Create a friend request | 20/hour per user |
| `POST /api/friends/accept` | Accept + create the DM conversation | 20/hour per user |
| `GET /api/conversations/:id/messages` | Paginated message history | 60/min per user |
| `POST /api/upload` | Media upload (image/video/file, and avatars) | 10/min per user |

Same shared rate-limit store as auth.md §10 and profile.md §12, so limits behave identically everywhere in the app.

---

## 15. Pros and Cons

### Pros

| | |
|---|---|
| **One schema, one set of `JOIN`s** | Friends, conversations, and messages sit in the same Postgres as `user` and `session` — no cross-service calls, no webhook mirroring (auth.md §14.2) |
| **Instant revocation reaches chat too** | Deleting a `session` row disconnects the socket in the same instant it kills the web session (auth.md §7) |
| **DMs and groups share one code path** | Message sending, history, and unread counts are written once ([§9](#9-group-chat-vs-11--one-table-not-two)) |
| **Media never touches our server for calls** | WebRTC is peer-to-peer; a $5 server can host video calling because it only ever relays a few kilobytes of signaling text |
| **Media for messages is one pipeline** | Avatars and chat attachments share `/api/upload`, Cloudinary, and the same MIME-sniffing/size-limit rules (profile.md §4) |
| **Privacy toggles are enforced once, everywhere** | `discoverable`, `friendRequests`, `onlineStatus` gate search results *and* presence broadcasts server-side, not per-feature |
| **Honest about what it isn't** | No claimed E2EE, no hidden read-receipt promise — [§13](#13-what-we-deliberately-dont-build) says exactly where the edges are |

### Cons

| | Mitigation |
|---|---|
| **Messages are plaintext in the database** | Encrypted in transit only, same as Slack/Discord. Documented, never hidden — see [§13](#13-what-we-deliberately-dont-build) |
| **Group video calls cap at 4 people** | Server-enforced, with the bandwidth math shown in [§12](#12-group-calls--mesh-topology-and-the-4-person-cap); an SFU is the documented next step, not built |
| **~10–15% of calls need TURN and we don't run one by default** | STUN-only works for the large majority of home-network calls; adding TURN later is pure config, zero code changes |
| **Presence relies on one in-memory `Map`** | Exactly correct at one server process; the day a second process exists, this becomes a Redis migration, not a bug fix |
| **No per-message read ticks in groups** | `lastReadAt` gives an unread *count*, not a per-message *who's seen this* — acceptable until someone specifically asks for group read receipts |
| **`ILIKE` search, not full-text** | Fast enough into the tens of thousands of messages; a `tsvector` + GIN index is the documented upgrade, not a redesign |

---

## 16. Launch Checklist

**Socket auth**
- [ ] Handshake rejects a missing/invalid/expired session cookie
- [ ] Deleting a `session` row in the database disconnects that device's socket on its very next check
- [ ] Every handler reads `socket.data.userId` — grep for any handler trusting a client-supplied `userId`/`from` field and fix it

**Messages**
- [ ] `message:send` rejects a user who isn't a `conversation_member` of the target conversation
- [ ] Rate limit (30/10s) actually trips when tested
- [ ] The `(conversationId, createdAt)` index exists — confirm with `EXPLAIN` on a history query

**Media**
- [ ] MIME sniffed from magic bytes, not filename, for chat attachments
- [ ] Size limits enforced server-side: images 5MB / videos 20MB / files 10MB
- [ ] Upload rate limit (10/min) trips when tested

**Presence & privacy**
- [ ] Two tabs, close one → still shows online
- [ ] `onlineStatus: NOBODY` hides both your status from others *and* others' status from you (symmetric, per profile.md §6)
- [ ] Search and friend-request handlers respect `discoverable` / `friendRequests` toggles server-side, not just in the UI

**Calls**
- [ ] Camera/mic permission denial shows a clear error, not a blank screen
- [ ] A 5th participant is rejected **by the server**, verified by emitting `call:join` directly from the browser console, not just by the UI hiding the button
- [ ] Mute/camera-off use `track.enabled = false`, never `track.stop()`
- [ ] A missed call (30s, no answer) logs `call_log.status = MISSED`

**Flow**
- [ ] Two-browser test: sign up, search, friend request, accept, chat live, presence, typing, media message, video call, mute, hang up — all pass end to end
- [ ] Four-tab test: group call fills at 4, a 5th is rejected, someone leaving frees a slot

---

## 17. Connecting It to the Rest of the Stack

Mechanical build order, following the same shape as auth.md §14 — this section is *how to wire it up*, not *why it works that way* (that's everything above).

```
1. db/schema/chat/{friend-request,conversation,conversation-member,message,call-log}.js
   + db/schema/chat/index.js re-exporting all five (mirrors db/schema/profile/index.js)
2. db/schema/index.js — add `...require("./chat")` alongside ./auth and ./profile
3. npx drizzle-kit push                          → tables now exist in Neon
4. Install socket.io (server/) and socket.io-client (web/) — neither is in
   package.json yet
5. server/src/index.js — boot Express + Socket.IO on :4000
6. server/src/auth.js  — the handshake middleware from §3, reading the
   same `db` and `session` table Better Auth writes to
7. server/src/presence.js — the online-users Map from §7
8. server/src/handlers/{chat,call,notify}.js — message:send, typing,
   call:invite/accept, rtc:* relay, notify:friend-request
9. types/socket.js — JSDoc @typedef payload shapes for every event in
   §14, imported by both workspaces (web/ gets full autocomplete from
   the JSDoc; server/ gets the same file with zero build step)
10. web/src/hooks/useSocket.ts  — one shared socket instance for the app
    web/src/hooks/useMessages.ts, usePresence.ts, useWebRTC.ts
11. web/src/components/chat/{MessageList,MessageInput,Bubble}.tsx
    web/src/components/call/{CallModal,VideoGrid,CallControls}.tsx
```

**Why step 4 matters:** `server/package.json` currently lists only `express`; `web/package.json` has no `socket.io-client`. Nothing in §3–§12 works until both are actually installed — this is the first concrete thing to do, not an afterthought.

**Verifying the chain end to end**, mirroring auth.md §14.8: sign up two test accounts in two browsers → friend request + accept → confirm a `conversation` row and two `conversation_member` rows exist in `drizzle-kit studio` → send a message → confirm it appears live in the other browser *and* as a row in `message` → delete one account's `session` row in Studio → confirm that browser's socket disconnects immediately. If the last step doesn't disconnect the socket, the handshake middleware is caching session state somewhere instead of reading `db` live on every check — the same failure mode auth.md §14.8 warns about for the web session.

---

## Summary

**Three transports, three jobs:** HTTP for anything request/response (history, search, upload), WebSocket for anything live (messages, presence, typing, call setup), WebRTC for the actual audio/video, peer-to-peer, never touching our server.

**One schema, one `db`:** `friend_request`, `conversation`, `conversation_member`, `message`, and `call_log` all reference the same `user` table auth.md and profile.md already built — no separate chat database, no sync job, no drift.

**Why it's fast to feel:** optimistic message bubbles, a single in-memory presence `Map` at this scale, and STUN-only WebRTC that never routes media through our server.

**Why it's honest:** plaintext-in-database is stated outright, group calls cap at 4 with the actual math shown, read receipts are a count not a per-message tick, and every one of those is a documented trade-off with a named upgrade path — not a silent limitation discovered the hard way.
