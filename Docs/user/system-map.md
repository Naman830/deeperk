# System Map — Login, Sessions, and Profile Settings

A visual companion to [`auth.md`](./auth.md) and [`profile.md`](./profile.md). Those two documents are the source of truth; this one just draws the pictures. If a diagram here and the prose there ever disagree, the prose wins — update this file.

---

## Table of Contents

1. [The Whole Thing at a Glance](#1-the-whole-thing-at-a-glance)
2. [Login & Signup, Step by Step](#2-login--signup-step-by-step)
3. [The Auth Schema](#3-the-auth-schema)
4. [Three Strength Layers](#4-three-strength-layers)
5. [Profile & Settings Surface](#5-profile--settings-surface)
6. [The Profile Schema](#6-the-profile-schema)
7. [The "Confirm It's You" Gate](#7-the-confirm-its-you-gate)
8. [Deactivate vs. Delete](#8-deactivate-vs-delete)

---

## 1. The Whole Thing at a Glance

Login and signup share one door — the user only ever types an email. The server decides whether that becomes a sign-in or a sign-up, and nothing is ever said aloud about which (auth.md §6, User Enumeration).

```mermaid
flowchart TD
    A["Open app"] --> B["Enter email"]
    B --> C{"account exists?<br/>(checked silently)"}
    C -->|yes| D["Send login OTP<br/>Better Auth emailOTP"]
    C -->|no| E["Send signup OTP<br/>our PendingRegistration"]
    D --> F["Enter 6-digit code"]
    E --> F
    F --> G{"code correct?"}
    G -->|"existing user"| H["Session created<br/>logged in"]
    G -->|"new user"| I["Name → Username →<br/>Date of birth → Password"]
    I --> J["Create account<br/>(User row written HERE)"]
    J --> H
    H --> K["Complete profile<br/>avatar + bio — skippable"]
    K --> L["/settings — editable forever"]

    style H fill:#3F4FD1,color:#fff,stroke:none
    style J fill:#3F4FD1,color:#fff,stroke:none
```

The response to "does this account exist" is identical either way, so the flow can't be probed for a user list.

---

## 2. Login & Signup, Step by Step

Three endpoints we own (`/auth/start`, `/auth/verify`, `/auth/complete`); everything else — hashing, sessions, rate limiting, CSRF — is Better Auth (auth.md §2).

```mermaid
sequenceDiagram
    participant U as Browser
    participant S as /api/auth/*
    participant DB as Postgres (user, account, session, pending_registration)

    U->>S: POST /auth/start { email }
    S->>S: normalize, rate-limit (5/hr per email, 20/hr per IP)
    S->>DB: SELECT id FROM user WHERE email = ?
    alt found
        S->>DB: (Better Auth) create Verification row, send login OTP
    else not found
        S->>DB: INSERT pending_registration { email, otpHash, expiresAt }
    end
    S-->>U: 200 { ok: true } — identical either way

    U->>S: POST /auth/verify { email, code }
    S->>DB: look up pending_registration / verification
    Note over S: 3 wrong attempts → row deleted, not just counted
    S->>DB: timing-safe compare hash(code) vs stored otpHash
    alt existing user
        S->>DB: create session row + httpOnly cookie
        S-->>U: logged in
    else new user
        S-->>U: short-lived registration-token cookie (15 min)
        U->>S: POST /auth/complete { name, username, dob, password }
        S->>S: re-validate all fields, age >= 13, HIBP breach check
        S->>DB: INSERT user (emailVerified=true) + account (scrypt hash) + session
        S-->>U: logged in, no "now sign in" screen
    end
```

**Field rules (server-enforced, auth.md §9):**

| Field | Rule |
|---|---|
| `email` | lowercased, trimmed, unique |
| `username` | 3–20 chars, `a–z 0–9 . _`, reserved-word blocklist |
| `birthDate` | real date, age ≥ 13 |
| `password` | 10–128 chars, no composition rules, breach-checked |

---

## 3. The Auth Schema

One shared Postgres schema — auth tables and app tables in the same `db` object (`db/schema/index.js`), so friend search and profile lookups are plain SQL joins (auth.md §14.2).

```mermaid
erDiagram
    USER ||--o{ ACCOUNT : "credentials"
    USER ||--o{ SESSION : "one row per device"
    USER ||--o| TWO_FACTOR : "opt-in"
    USER ||--o{ AUTH_EVENT : "audit log (no FK)"
    PENDING_REGISTRATION ||--|| USER : "verified email → becomes"

    USER {
        text id PK
        text email UK
        text username UK
        text displayUsername
        boolean emailVerified
        date birthDate "private, never public"
        text phoneNumber "profile only, never auth"
        boolean twoFactorEnabled
        timestamp deactivatedAt
        timestamp deletionScheduledAt
    }
    ACCOUNT {
        text id PK
        text userId FK
        text providerId "credential = password"
        text password "scrypt hash + salt"
    }
    SESSION {
        text id PK
        text token UK
        text userId FK
        timestamp expiresAt "30d, rolling"
        text ipAddress
        text userAgent
    }
    TWO_FACTOR {
        text id PK
        text userId FK
        text secret "encrypted at rest"
        text backupCodes "hashed, single-use"
    }
    PENDING_REGISTRATION {
        text id PK
        text email UK
        text otpHash "sha-256, never plaintext"
        int attempts "burned at 3"
        timestamp expiresAt "15 min"
    }
    AUTH_EVENT {
        text id PK
        text userId "nullable, no FK"
        text type "login_ok, otp_sent, ..."
        text ipAddress
        timestamp createdAt
    }
```

`account`, `session`, `two_factor` cascade-delete with the user; `auth_event.userId` deliberately has no FK, so a failed login against an unknown email still gets logged.

**Never stored:** plaintext passwords or OTPs, session tokens in logs or `localStorage`, security questions, unhashed backup codes. If it can be used to *become* the user, it's hashed or it isn't stored at all (auth.md §5).

---

## 4. Three Strength Layers

All three are invisible to a user who never needs them (auth.md §8).

| Layer | When | What happens | Stops |
|---|---|---|---|
| **1 · Breach check** | always on | SHA-1 prefix (5 chars) sent to HIBP's k-anonymity range API; full hash never leaves the server | Credential stuffing — the attack that actually takes accounts |
| **2 · TOTP 2FA** | opt-in | Confirm password → scan QR → type a code to prove it works → 10 backup codes shown once | Password-only takeover; step 3 is non-negotiable to avoid lockouts |
| **3 · Sessions + alerts** | always on | Every session listed (device, browser, IP-location, last active); email on a new device | Doesn't prevent — it's the only layer that *detects* a successful breach |

**Why sessions, not JWTs (auth.md §7):**

| | Database session | JWT |
|---|---|---|
| Revoke one device | instant — delete the row | impossible until expiry |
| Log out everywhere | one `DELETE` | needs a blocklist (= a database) |
| Cost per request | ~1ms, cached 5 min | zero |

The Socket.IO server on `:4000` reads the same `session` table on every handshake — deleting a row disconnects that device's chat socket in the same instant it kills the web session.

---

## 5. Profile & Settings Surface

The same person's data, shown two ways: an **allow-listed** public page, and a settings area split into four tabs by risk (profile.md §2).

```mermaid
flowchart LR
    subgraph PUB["/u/username — what others see"]
        direction TB
        P1["avatar, name, @username"]
        P2["bio, website, location"]
        P3["interests, social links"]
        P4["Add friend / Message"]
    end
    subgraph SET["/settings — what only you see"]
        direction TB
        S1["Profile — name, bio, DOB, interests, socials"]
        S2["Account — email, phone"]
        S3["Privacy — 4 visibility toggles"]
        S4["Security — password, 2FA, sessions, delete"]
    end
    U["User row"] --> PUB
    U --> SET
    style S2 fill:#F5EEDD,stroke:#9C6E1F,color:#1B1E27
    style S4 fill:#F6E7E3,stroke:#B94A34,color:#1B1E27
```

The public page is built from an explicit column allow-list; a private field added later stays private by default (profile.md §11).

**Settings tabs, by what they touch:**

| Tab | Gate | Touches |
|---|---|---|
| **Profile** | instant save | Name, bio, website, location, gender, interests, social links. Username: 1 change / 30 days, old handle held 30 days |
| **Account** | password-gated | Change email (password → OTP to new address → alert to old address → revokes other sessions); verify phone (badge only, grants nothing) |
| **Privacy** | enum toggles | Discoverable · friend requests · online status · profile details — each `Everyone / Friends of friends / Friends / Nobody`, enforced server-side |
| **Security** | password-gated | Change password (revokes every other session), 2FA enable/disable + backup codes, device list, logout / logout everywhere / deactivate / delete |

---

## 6. The Profile Schema

Small deltas on top of `user` — new tables only where the data has its own shape (profile.md §10).

```mermaid
erDiagram
    USER ||--o| PRIVACY_SETTINGS : "one row per user"
    USER ||--o{ SOCIAL_LINK : "up to 5"
    USER ||--o{ PENDING_CONTACT_CHANGE : "email or phone in flight"

    USER {
        text website
        text location
        text gender
        text_array interests "up to 10 tags"
        timestamp usernameChangedAt "30-day cooldown"
        timestamp deactivatedAt
        timestamp deletionScheduledAt
    }
    PRIVACY_SETTINGS {
        text userId PK
        enum discoverable "EVERYONE default"
        enum friendRequests
        enum onlineStatus
        enum profileDetails
    }
    SOCIAL_LINK {
        text id PK
        text userId FK
        text platform "github, x, ..."
        text url
    }
    PENDING_CONTACT_CHANGE {
        text id PK
        text userId FK
        enum type "EMAIL or PHONE"
        text newValue
        text otpHash "sha-256"
        timestamp expiresAt "5 min"
    }
```

`pending_contact_change` mirrors `pending_registration`: a row can be partially invalidated after 3 wrong guesses; a JWT can't.

---

## 7. The "Confirm It's You" Gate

One reusable checkpoint sits in front of every action that could hand over the account (profile.md §9).

```mermaid
flowchart TD
    A["User clicks a sensitive action"] --> B{"password confirmed<br/>in the last 5 min?"}
    B -->|yes| C["Proceed"]
    B -->|no| D["Ask for password"]
    D --> E{"correct?"}
    E -->|"5 wrong"| F["Locked 15 minutes"]
    E -->|right| C
    style C fill:#256F49,color:#fff,stroke:none
    style F fill:#B94A34,color:#fff,stroke:none
```

| Needs the gate | Skips it |
|---|---|
| Change email · phone · password · 2FA · backup codes · logout everywhere · deactivate · delete | Name, bio, website, location, avatar, gender, interests, socials, privacy toggles, username *(rate-limited instead)* |

The threat this stops isn't a stolen password — the session is already valid. It's an unlocked laptop or an XSS request riding that live session, where the attacker has everything *except* the password.

---

## 8. Deactivate vs. Delete

Two different intentions get two different buttons — merging them is how people destroy an account they only wanted to hide (profile.md §8).

```mermaid
flowchart TD
    Start["Settings → Security"] --> Deact["Deactivate"]
    Start --> Del["Delete"]

    Deact --> D1["deactivatedAt = now()"]
    D1 --> D2["hidden from search + suggestions<br/>all sessions revoked<br/>messages untouched"]
    D2 --> D3["log back in → instantly restored"]

    Del --> L1["confirm password + type username"]
    L1 --> L2["deletionScheduledAt = now() + 30 days<br/>behaves as deactivated meanwhile"]
    L2 --> L3{"log in within 30 days?"}
    L3 -->|yes| D3
    L3 -->|no| L4["nightly job anonymizes:<br/>name → 'Deleted User'<br/>email/phone → NULL<br/>account/session/2FA rows deleted<br/>message TEXT kept, re-authored"]

    style D3 fill:#256F49,color:#fff,stroke:none
    style L4 fill:#B94A34,color:#fff,stroke:none
```

Message text survives anonymization on purpose: deleting it would tear holes in other people's conversations.
