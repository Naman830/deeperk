# System Map — Chat & Calling

A visual companion to [`chat.md`](./chat.md), the same way [`system-map.md`](./system-map.md) is a companion to `auth.md` and `profile.md`. `chat.md` is the source of truth; this one just draws the pictures. If a diagram here and the prose there ever disagree, the prose wins — update this file.

**Status:** every diagram below is the target design. None of this is built yet — see `chat.md`'s opening note for what that means.

---

## Table of Contents

1. [The Whole Thing at a Glance](#1-the-whole-thing-at-a-glance)
2. [Three Transports, One App](#2-three-transports-one-app)
3. [The Socket Handshake](#3-the-socket-handshake)
4. [Friend Request → Conversation](#4-friend-request--conversation)
5. [The Chat & Call Schema](#5-the-chat--call-schema)
6. [Sending a Message](#6-sending-a-message)
7. [Presence & the Multi-Tab Problem](#7-presence--the-multi-tab-problem)
8. [The WebRTC Call Handshake](#8-the-webrtc-call-handshake)
9. [Group Call Mesh Topology](#9-group-call-mesh-topology)

---

## 1. The Whole Thing at a Glance

```mermaid
flowchart TD
    A["Logged in — session cookie set (auth.md)"] --> B["Search a username"]
    B --> C["Send friend request"]
    C --> D{"accepted?"}
    D -->|yes| E["Conversation + 2 members created"]
    D -->|no / pending| B
    E --> F["Chat — live messages, presence, typing, media"]
    E --> G["Call — audio/video, peer-to-peer"]
    F --> H["Notifications — badge, toast, title, sound"]
    G --> H

    style E fill:#3F4FD1,color:#fff,stroke:none
    style F fill:#256F49,color:#fff,stroke:none
    style G fill:#256F49,color:#fff,stroke:none
```

Discovery is deliberately narrow — a username search and a friend request, nothing browsable. Everything below this line only happens between two accounts that already agreed to talk (chat.md §4).

---

## 2. Three Transports, One App

```mermaid
flowchart LR
    subgraph HTTP[":3000 — Next.js — HTTP"]
        direction TB
        H1["Message history (paged)"]
        H2["Friend requests"]
        H3["Media upload"]
        H4["Username search"]
    end
    subgraph WS[":4000 — Socket.IO — WebSocket"]
        direction TB
        W1["message:send / message:new"]
        W2["typing:start / typing:stop"]
        W3["presence:online / offline"]
        W4["call:invite / accept / rtc:*"]
    end
    subgraph RTC["Browser ↔ Browser — WebRTC"]
        direction TB
        R1["Audio + video, peer-to-peer"]
        R2["Never touches the server"]
    end

    DB[("Postgres — one shared schema")]
    HTTP --> DB
    WS --> DB
    WS -.->|"signaling only, tiny JSON"| RTC

    style RTC fill:#256F49,color:#fff,stroke:none
```

The server's only role in a call is the dotted line — introducing two browsers. Everything solid inside `RTC` never routes through `:3000` or `:4000` (chat.md §2, §11).

---

## 3. The Socket Handshake

The socket server has no login of its own — it reads the exact `session` row Better Auth already wrote (auth.md §7, chat.md §3).

```mermaid
sequenceDiagram
    participant U as Browser
    participant S as Socket.IO :4000
    participant DB as Postgres (session table)

    U->>S: WebSocket connect (session cookie attached automatically)
    S->>DB: SELECT * FROM session WHERE token = ? AND expires_at > NOW()
    alt no valid row
        DB-->>S: nothing
        S-->>U: connection rejected
    else valid row
        DB-->>S: session { userId, ... }
        S->>S: socket.data.userId = session.userId
        S->>S: join room user:<userId>
        S->>S: join room conversation:<id> for every conversation this user is in
        S-->>U: connected
    end

    Note over S,DB: Deleting this session row mid-call disconnects<br/>the socket on its very next check — same table, same instant.
```

---

## 4. Friend Request → Conversation

```mermaid
flowchart TD
    A["Search username"] --> B["Privacy check:<br/>discoverable toggle (profile.md §6)"]
    B --> C["POST /api/friends/request"]
    C --> D["friend_request row: PENDING"]
    D --> E["notify:friend-request → user:&lt;theirId&gt;"]
    E --> F{"they respond"}
    F -->|"accept"| G["status → ACCEPTED"]
    F -->|"reject"| H["status → REJECTED"]
    G --> I["conversation row: type DIRECT"]
    I --> J["2× conversation_member rows"]
    J --> K["Both sidebars get the new chat"]

    style G fill:#256F49,color:#fff,stroke:none
    style I fill:#3F4FD1,color:#fff,stroke:none
    style H fill:#B94A34,color:#fff,stroke:none
```

One `friend_request` row serves as both the pending request and, once `ACCEPTED`, the friendship itself — there is no separate `friendship` table (chat.md §4).

---

## 5. The Chat & Call Schema

None of these tables exist in `db/schema/` yet — they'd live in a new `db/schema/chat/` folder, referencing the real `user` table the same way `db/schema/profile/*` already does (chat.md §5).

```mermaid
erDiagram
    USER ||--o{ FRIEND_REQUEST : "sender or receiver"
    USER ||--o{ CONVERSATION_MEMBER : "belongs to"
    USER ||--o{ MESSAGE : "sends"
    USER ||--o{ CALL_LOG : "starts"
    CONVERSATION ||--o{ CONVERSATION_MEMBER : "has"
    CONVERSATION ||--o{ MESSAGE : "contains"
    CONVERSATION ||--o{ CALL_LOG : "logs calls in"

    USER {
        text id PK
        text username UK "from auth.md — unchanged here"
        boolean isOnline
        timestamp lastSeenAt
    }
    FRIEND_REQUEST {
        text id PK
        text senderId FK
        text receiverId FK
        enum status "PENDING/ACCEPTED/REJECTED"
        timestamp createdAt
    }
    CONVERSATION {
        text id PK
        enum type "DIRECT or GROUP"
        text name "groups only"
        text createdById FK
        timestamp updatedAt "sorts the sidebar"
    }
    CONVERSATION_MEMBER {
        text conversationId PK_FK
        text userId PK_FK
        enum role "OWNER/ADMIN/MEMBER"
        timestamp lastReadAt "powers unread badges"
    }
    MESSAGE {
        text id PK
        text conversationId FK
        text senderId FK
        enum type "TEXT/IMAGE/VIDEO/FILE/SYSTEM"
        text body
        text mediaUrl
        timestamp createdAt "indexed with conversationId"
        timestamp deletedAt "soft delete"
    }
    CALL_LOG {
        text id PK
        text conversationId FK
        text startedById FK
        enum kind "AUDIO or VIDEO"
        enum status "RINGING/ONGOING/ENDED/MISSED/REJECTED"
        text_array participantIds
    }
```

`conversation_member` cascade-deletes with both `user` and `conversation`. The composite index on `message(conversationId, createdAt)` is the single most important index in the app — every chat open runs that exact query (chat.md §5).

---

## 6. Sending a Message

```mermaid
sequenceDiagram
    participant U as Sender's browser
    participant S as Socket.IO :4000
    participant DB as Postgres
    participant R as Conversation room (all members)

    U->>U: render bubble instantly, clock icon, tempId
    U->>S: message:send { conversationId, text, tempId }
    S->>S: authenticated? member of conversation? length 1-4000? rate limit ok?
    alt any check fails
        S-->>U: rejected
    else all pass
        S->>DB: INSERT message
        S->>DB: UPDATE conversation.updatedAt
        S->>R: message:new (broadcast)
        R-->>U: matched by tempId → clock becomes a checkmark
        R-->>R: everyone else renders the bubble, plays a ping
    end
```

The membership check is not optional — without it, anyone who learns a `conversationId` could post into a conversation they were never added to (chat.md §6).

---

## 7. Presence & the Multi-Tab Problem

```mermaid
flowchart TD
    A["Socket connects"] --> B{"already in the<br/>online Map?"}
    B -->|no| C["mark isOnline = true<br/>broadcast presence:online"]
    B -->|yes, another tab| D["just add this socketId<br/>to the existing Set"]
    C --> E["online.set(userId, {socketId})"]
    D --> E

    F["Socket disconnects"] --> G["remove this socketId<br/>from the Set"]
    G --> H{"Set now empty?"}
    H -->|yes — last tab| I["mark isOnline = false<br/>lastSeenAt = now()<br/>broadcast presence:offline"]
    H -->|no — other tabs open| J["stay online, do nothing"]

    style I fill:#B94A34,color:#fff,stroke:none
    style C fill:#256F49,color:#fff,stroke:none
```

The `Map` lives in the Socket.IO process's memory. It's exactly correct with one server; a second server process would need this moved to Redis (chat.md §7, §13).

---

## 8. The WebRTC Call Handshake

Ten steps, one handshake, repeated for every call — signaling rides the same socket connection from §3; the media itself never does.

```mermaid
sequenceDiagram
    participant A as Alice
    participant S as Socket.IO :4000
    participant B as Bob

    A->>A: getUserMedia() — camera + mic
    A->>S: call:invite { to: bob, kind: VIDEO }
    S->>B: call:invite (ring, 30s timeout → MISSED)
    B->>B: getUserMedia()
    B->>S: call:accept { to: alice }
    S->>A: call:accept

    A->>A: new RTCPeerConnection(stunConfig)
    B->>B: new RTCPeerConnection(stunConfig)

    A->>A: createOffer() + setLocalDescription()
    A->>S: rtc:offer { to: bob, offer }
    S->>B: rtc:offer
    B->>B: setRemoteDescription(offer)
    B->>B: createAnswer() + setLocalDescription()
    B->>S: rtc:answer { to: alice, answer }
    S->>A: rtc:answer
    A->>A: setRemoteDescription(answer)

    par ICE trickles both directions
        A->>S: rtc:ice-candidate
        S->>B: rtc:ice-candidate
    and
        B->>S: rtc:ice-candidate
        S->>A: rtc:ice-candidate
    end

    Note over A,B: Direct peer connection established.<br/>Audio/video now flows browser-to-browser — the server is out of the loop.
```

---

## 9. Group Call Mesh Topology

```mermaid
flowchart LR
    Alice((Alice)) --- Bob((Bob))
    Alice --- Carol((Carol))
    Alice --- Dave((Dave))
    Bob --- Carol
    Bob --- Dave
    Carol --- Dave

    style Alice fill:#3F4FD1,color:#fff,stroke:none
    style Bob fill:#3F4FD1,color:#fff,stroke:none
    style Carol fill:#3F4FD1,color:#fff,stroke:none
    style Dave fill:#3F4FD1,color:#fff,stroke:none
```

4 people, 6 direct connections, each uploading a separate copy of their stream to every other participant — the arithmetic behind the server-enforced cap of 4 (chat.md §12). A 5th `call:join` is rejected by the server, not just hidden by the UI.
