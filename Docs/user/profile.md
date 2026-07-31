# Profile & Settings — Who You Are on ChatSphere

This document picks up **exactly where [`auth.md`](./auth.md) stops.** Auth's last step is "Complete Profile (avatar, bio — skippable)". Everything after that arrow is this document.

**Design goal:** editing your profile should feel light, and changing anything *security-related* should feel deliberate. Those are two different feelings, so they live on two different screens.

---

## Table of Contents

1. [Where This Connects to Auth](#1-where-this-connects-to-auth)
2. [Two Surfaces: Public Profile vs Settings](#2-two-surfaces-public-profile-vs-settings)
3. [The Profile Tab — Everyday Fields](#3-the-profile-tab--everyday-fields)
4. [Avatar Upload](#4-avatar-upload)
5. [The Account Tab — Email & Phone](#5-the-account-tab--email--phone)
6. [The Privacy Tab](#6-the-privacy-tab)
7. [The Security Tab](#7-the-security-tab)
8. [Deactivate & Delete](#8-deactivate--delete)
9. [Confirm It's You](#9-confirm-its-you)
10. [Database — What We Add](#10-database--what-we-add)
11. [What a Public Profile Must Never Return](#11-what-a-public-profile-must-never-return)
12. [Endpoints & Rate Limits](#12-endpoints--rate-limits)
13. [Pros and Cons](#13-pros-and-cons)
14. [Launch Checklist](#14-launch-checklist)

---

## 1. Where This Connects to Auth

```
  auth.md · Step 8 — Create Account
        │   User row written, session cookie set, logged in
        ▼
  auth.md · Step 9 — Complete Profile      ← the seam between the two docs
        │   avatar + bio, SKIPPABLE
        │
        ├── "Skip" ──────────────────► straight into the app
        │
        └── filled in ───────────────► straight into the app
                                            │
                                            ▼
                              ┌─────────────────────────────┐
                              │  Everything below is         │
                              │  editable forever, from      │
                              │  /settings                   │
                              └─────────────────────────────┘
```

**Three rules inherited from auth.md that we do not break:**

| Rule | Where it comes from | What it means here |
|---|---|---|
| Nothing in the profile can block access to the app | auth.md §3 Step 9 | Every field on this page is optional except the four set at signup |
| Email is the only recovery path | auth.md §11 Cons | Changing it is the single most dangerous action in Settings — §5 treats it that way |
| Phone is **never** an auth identifier | auth.md §4 | We add a ✓ badge in §5, and that badge grants nothing |

> **The seam in one sentence:** auth.md creates the account, profile.md maintains it. No new session logic, no new cookie, no new login path.

---

## 2. Two Surfaces: Public Profile vs Settings

The same data, seen two ways. Keeping them separate is what stops a private field leaking by accident.

```
  /u/naman                                /settings
  ─────────────────────────               ──────────────────────────────
  WHAT OTHERS SEE                         WHAT ONLY YOU SEE

    ( avatar )                            ┌ Profile   name, username, bio,
    Naman Kumar                           │           website, location, DOB,
    @naman                                │           gender, interests, socials
    "building chat apps 🚀"               │
    🔗 naman.dev                          ├ Account   email, phone
    📍 Delhi, India                       │
    #webdev #music                        ├ Privacy   4 visibility toggles
                                          │
    [ Add friend ]  [ Message ]           └ Security  password, 2FA, sessions,
                                                      deactivate/delete, logout
```

**Why split them?** The public page is built from an explicit *allow-list* of columns (§11). The settings page is built from the logged-in user's own row. There is no query that can accidentally serve one as the other.

**Where these live** (following the structure in README §10):

```
web/src/app/(app)/u/[username]/page.tsx     ← public profile
web/src/app/(app)/settings/
    profile/page.tsx
    account/page.tsx
    privacy/page.tsx
    security/page.tsx
```

---

## 3. The Profile Tab — Everyday Fields

These save instantly with one **Save** button. No password, no OTP, no confirmation — they're low-risk and frequent.

| Field | Rules | Public? | Notes |
|---|---|---|---|
| **Display Name** | 1–50 chars, any Unicode, emoji fine | Yes | Same rule as auth.md §9. `Naman 🚀` is valid. |
| **Username** | 3–20 chars, `a–z 0–9 . _`, reserved-word blocklist | Yes | Changeable — see the box below |
| **Bio** | 0–200 chars, plain text | Yes | Rendered as text, never as HTML |
| **Website** | Valid `http(s)` URL, max 200 chars | Yes | Rendered with `rel="nofollow noopener noreferrer"` |
| **Location** | 0–60 chars, free text | Yes | Free text, not a map lookup — no geodata, no third-party API |
| **Date of Birth** | Set at signup, age ≥ 13 | **Never** | Editable, but the 13+ check re-runs server-side |
| **Gender** | Optional: Male / Female / Non-binary / Prefer not to say / Custom (30 chars) | Optional | Default is unset, and unset is a perfectly normal state |
| **Interests** | Up to 10 tags, 1–24 chars each, lowercase | Yes | A `String[]` column — no join table for a list this small |
| **Social Links** | Up to 5, each a platform + URL | Yes | Own table (§10), not a JSON blob |

### Changing your username

`username` is your address — friend search and `@mentions` match against it (README §6). So changes are allowed but slowed down:

```
  New username typed
      │
      ├─ same live availability check as signup (auth.md §3, Steps 4–7)
      ├─ 1 change per 30 days                    ← stops name-squatting churn
      └─ on success:
            username         = new (lowercase)
            displayUsername  = new (as typed)
            old username → held 30 days, then released
```

**Why hold the old one for 30 days?** If `@naman` were freed instantly, someone could grab it the same minute and inherit conversations where people still think that handle is you. Thirty days of nothing is a cheap fix for impersonation.

> **Two names, on purpose** — `username` is stored lowercase and is what search matches; `displayUsername` keeps what you actually typed (`NamanK`). This is auth.md §4's rule, unchanged.

### Validation happens twice

Client-side for feel, server-side for safety. That's not duplicated effort — it's the rule from README §8.5: **the client check is a courtesy, the server check is the real one.** Anyone can open DevTools and POST directly.

---

## 4. Avatar Upload

Reuses the existing `/api/upload` pipeline (README §8.5) — no new infrastructure.

```
  Pick an image
      │
      ▼
  CLIENT: crop to a square, preview it            ← purely for feel
      │
      ▼
  POST /api/upload  (multipart)
      │
      ├─ 1. logged in?
      ├─ 2. real MIME from magic bytes            ← never trust the filename
      ├─ 3. jpeg / png / webp only, ≤ 5 MB
      ├─ 4. rate limit: 5 avatar uploads / hour
      │
      ▼
  Cloudinary → resize 512×512, convert to webp, strip EXIF
      │
      ▼
  PATCH /api/me { avatarUrl }  →  User.avatarUrl updated
```

**Strip EXIF.** A photo taken on a phone can carry GPS coordinates of where it was shot. Publishing that on a public profile hands out someone's home address. Cloudinary drops metadata on transform — make sure that's on.

**Remove avatar** → `avatarUrl = null`, delete the Cloudinary asset, and the UI falls back to a generated initials circle (`N` on a colour derived from the user id). Never a broken image, never a blank grey box.

---

## 5. The Account Tab — Email & Phone

This tab holds the two contact fields. They behave completely differently, and understanding *why* is the point of this section.

### Change Email — the most dangerous action in Settings

Email is how you log in and the only way to recover the account (auth.md §11). So it gets the heaviest flow on this page.

```
  Settings → Account → Change email
      │
      ▼
  1. Confirm current password                    ← §9
      │
      ▼
  2. Type the new email
      │
      ├─ normalise: trim + lowercase             ← same as auth.md §3
      ├─ already in use? → generic "check your inbox"   (no enumeration, auth.md §6)
      └─ INSERT PendingContactChange { type: EMAIL, newValue, otpHash, expiresAt }
      │
      ▼
  3. 6-digit OTP sent to the NEW address
      │   3 attempts, 5-minute expiry, deleted on success  ← auth.md §6 rules, reused
      ▼
  4. Correct code:
      ├─ User.email = new value,  emailVerified = true
      ├─ 📧 alert to the OLD address: "your email was changed"
      ├─ revoke every OTHER session
      └─ AuthEvent { type: 'email_changed' }
```

**Why the notice to the old address matters more than it looks.** Password + OTP-to-new proves the person at the keyboard has the password and the new inbox. It does *not* prove they're the owner — a hijacked session has both. The old-inbox alert is the only thing the real owner will ever see, and it's their signal to hit "Secure your account" (auth.md §8, Layer 3).

**Why not OTP to the old address too?** People change email *because* they lost access to the old one. Requiring it would lock out the exact users who need the feature most.

### Verify Phone — a badge, and nothing more

```
  Enter number (E.164, e.g. +919876543210)
      │
      ▼
  SMS OTP  ·  6 digits  ·  5 min  ·  3 attempts   ← same shape as every other OTP here
      │
      ▼
  phoneNumber = value,  phoneVerified = true      ← a ✓ badge appears
```

> ### ⚠️ Read this before implementing phone
>
> `phoneVerified = true` grants **nothing**. It is not a login method, not a second factor, and not a recovery path. auth.md §8 rejects SMS as a factor because SIM swapping is a real, cheap attack, and that judgement stands.
>
> The badge exists so a friend can trust the number is real. That is its entire job.
>
> **Enforce it in code, not just in prose:** no route that issues a session, resets a password, or bypasses 2FA may ever read `phoneVerified`. If you're tempted, you're about to break auth.md §4.

Phone is also **removable** in one click, and stays visible only to friends. SMS costs money per message — the rate limit in §12 is as much a bill protector as a security control.

---

## 6. The Privacy Tab

Four toggles. Each is a single enum, and each defaults to the friendliest-but-safe option.

| Toggle | Options | Default | What it controls |
|---|---|---|---|
| **Who can find me** | Everyone · Friends of friends · Nobody | Everyone | Whether you appear in username search (README §8.2). Email search never exists at all — auth.md §6 forbids it. |
| **Who can send me friend requests** | Everyone · Friends of friends · Nobody | Everyone | Gates `POST /api/friends/request` server-side, not just the button |
| **Who can see my online status** | Everyone · Friends only · Nobody | Everyone | Hides `isOnline` and `lastSeenAt` (README §8.4) |
| **Who can see my profile details** | Everyone · Friends only | Everyone | Bio, website, location, interests, socials on `/u/[username]` |

**Online status is symmetric.** If you hide your last-seen, you stop seeing everyone else's. WhatsApp works this way and it's the right call — a one-way mirror lets someone watch without being watched, which is exactly the behaviour a privacy setting should not enable.

**"Nobody" still leaves you reachable.** Existing friends can always message you. These toggles govern *discovery*, not conversations you already have — otherwise turning on a privacy setting would silently break your chats.

**Every toggle is enforced in the API, never in the UI.** Hiding a button is decoration. The `GET /api/users/search` handler filters by the searcher's relationship to each result; the friend-request handler rejects with a generic 403.

---

## 7. The Security Tab

Most of this tab already exists in auth.md — this section is the map, not the implementation.

| Item | Where it's specified | What this page adds |
|---|---|---|
| **Device Sessions + Login Alerts** | auth.md §8, Layer 3 | The list UI: device, browser, approximate location, last active, with **Log out** per row and **Log out everywhere else** |
| **TOTP Two-Factor** | auth.md §8, Layer 2 | Entry point for enable/disable + "regenerate backup codes" |
| **Change Password** | auth.md §8, Layer 1 | The form below |
| **Logout** | auth.md §7 | Deletes this session's row |
| **Deactivate / Delete** | new — §8 below | |

### Change Password

```
  current password  →  new password  →  confirm
      │
      ├─ verify the current one                  ← blocks a hijacked session
      ├─ 10–128 chars, no composition rules       ← auth.md §9
      ├─ breach check against HIBP                ← auth.md §8, Layer 1
      │
      └─ on success:
            scrypt rehash → Account table
            revoke ALL other sessions             ← auth.md §7
            📧 "your password was changed"
            AuthEvent { type: 'password_changed' }
```

Revoking other sessions is the whole point of changing a password after a scare. A password change that leaves the intruder logged in has done nothing.

### Logout

```
  Logout          → DELETE this Session row → cookie cleared → socket disconnected
  Logout all      → DELETE every Session row for this user
```

Because sessions live in the database and the socket server reads the same table (auth.md §7), logging out kills chat **and** real-time in the same instant. This is exactly why auth.md chose sessions over JWTs.

---

## 8. Deactivate & Delete

Two different intentions, two different buttons. Merging them is how people permanently destroy an account they only wanted to hide.

```
  ┌── DEACTIVATE ─────────────────────────────────────────┐
  │  "Hide me for a while"                                │
  │                                                       │
  │  deactivatedAt = now()                                │
  │  ├─ removed from search + friend suggestions          │
  │  ├─ profile shows "This account is unavailable"       │
  │  ├─ ALL sessions revoked                              │
  │  └─ messages stay exactly where they are              │
  │                                                       │
  │  Reactivate: just log in. Nothing was lost.           │
  └───────────────────────────────────────────────────────┘

  ┌── DELETE ─────────────────────────────────────────────┐
  │  "I want this gone"                                   │
  │                                                       │
  │  1. Confirm password (§9)                             │
  │  2. Type your username to confirm                     │
  │  3. deletionScheduledAt = now() + 30 days             │
  │     → behaves as deactivated during the wait          │
  │     → 📧 "scheduled for deletion, log in to cancel"   │
  │                                                       │
  │  Logging in inside 30 days CANCELS it. One step.      │
  │                                                       │
  │  After 30 days, a nightly job anonymizes:             │
  │     name          → "Deleted User"                    │
  │     username      → "deleted_<random>"                │
  │     email/phone   → NULL                              │
  │     avatar, bio, website, location, DOB,              │
  │     gender, interests, socials  → deleted             │
  │     Account, Session, TwoFactor rows → deleted        │
  │     message TEXT  → kept, authored by "Deleted User"  │
  └───────────────────────────────────────────────────────┘
```

**Why 30 days?** The two most common reasons to hit delete are anger and a hijacked session. A grace period fixes both, and "log in to cancel" is a recovery flow the user already knows how to perform.

**Why keep the message text?** Deleting it would tear holes in *other people's* conversations — a thread where half the replies vanished is unreadable, and those messages are the other person's history too. Anonymizing the author removes the identity while leaving everyone else's chats intact.

**Why free the username?** Holding `@naman` forever on a dead account is waste. Same 30-day hold as a username change (§3) covers the impersonation risk.

> **One honest limitation.** Anonymizing keeps message *content*. If a user asks for full erasure of everything they ever typed, that's a manual database job today. Say so in your privacy policy rather than implying otherwise.

---

## 9. Confirm It's You

A single reusable gate, sitting in front of every dangerous action.

```
  User clicks a sensitive action
      │
      ├─ password confirmed in the last 5 minutes?  ──► proceed
      │
      └─ no ──► "Confirm your password to continue"
                     │
                     ├─ wrong ×5 → locked for 15 min
                     └─ right → stamp the session, proceed
```

**Which actions need it:**

| Needs confirmation | Doesn't |
|---|---|
| Change email · Change phone · Change password | Name, bio, website, location, avatar |
| Enable / disable 2FA · Regenerate backup codes | Gender, interests, social links |
| Log out everywhere · Deactivate · Delete | Privacy toggles |
| | Username change *(rate-limited instead)* |

**The threat this stops:** an unlocked laptop, or an XSS-driven request riding a live session. The session is valid, so nothing else would object — but the attacker doesn't know the password. Five minutes is short enough to matter and long enough not to nag someone doing three things at once.

---

## 10. Database — What We Add

Small deltas on top of the schema in README §6 and auth.md §4.

### `User` — new columns

```prisma
model User {
  // ... everything from README §6 and auth.md §4 ...

  website             String?                    // profile
  location            String?   @db.VarChar(60)
  gender              String?   @db.VarChar(30)  // free text so "Custom" just works
  interests           String[]  @default([])     // Postgres array — no join table needed

  usernameChangedAt   DateTime?                  // enforces the 30-day cooldown
  deactivatedAt       DateTime?                  // hidden, reversible
  deletionScheduledAt DateTime?                  // the 30-day countdown

  privacy             PrivacySettings?
  socialLinks         SocialLink[]

  @@index([deletionScheduledAt])                 // for the nightly sweep
}
```

### `PrivacySettings` — one row per user

```prisma
enum Audience { EVERYONE  FRIENDS_OF_FRIENDS  FRIENDS  NOBODY }

model PrivacySettings {
  userId          String   @id
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  discoverable    Audience @default(EVERYONE)   // who can find me
  friendRequests  Audience @default(EVERYONE)   // who can request
  onlineStatus    Audience @default(EVERYONE)   // last seen + green dot
  profileDetails  Audience @default(EVERYONE)   // bio, website, location, ...
}
```

Its own table rather than four more columns on `User`, because `User` is already the widest table in the app and these four always load together.

### `SocialLink`

```prisma
model SocialLink {
  id       String @id @default(cuid())
  userId   String
  user     User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  platform String                                 // "github" | "x" | "instagram" | ...
  url      String

  @@unique([userId, platform])                    // one link per platform
}
```

Typed rows, not a JSON blob — same reasoning as auth.md §2's "typed, not JSON soup".

### `PendingContactChange` — mirrors `PendingRegistration`

```prisma
enum ContactType { EMAIL  PHONE }

model PendingContactChange {
  id        String      @id @default(cuid())
  userId    String
  type      ContactType
  newValue  String                                // the new email or phone
  otpHash   String                                // SHA-256. NEVER the code.
  attempts  Int         @default(0)
  expiresAt DateTime                              // now + 5 min
  createdAt DateTime    @default(now())

  @@unique([userId, type])                        // one pending change at a time
  @@index([expiresAt])
}
```

This is `PendingRegistration` from auth.md §4 with a different name. Same reasoning too: **a JWT can't be invalidated after 3 wrong guesses; a row can.** Swept by the same nightly job.

### `AuthEvent` — new types, no schema change

Reuses the audit table from auth.md §4:

`profile_updated` · `username_changed` · `avatar_changed` · `email_changed` · `phone_verified` · `privacy_changed` · `account_deactivated` · `deletion_scheduled` · `deletion_cancelled`

Event **types** only — never the old value, never the new one. Writing `email_changed: naman@old.com → naman@new.com` into a log turns your audit trail into a leak.

---

## 11. What a Public Profile Must Never Return

`GET /api/users/:username` selects an explicit allow-list. Never `User.*`, never `include: { user: true }`.

```ts
// web/src/app/api/users/[username]/route.ts
const publicProfile = await prisma.user.findUnique({
  where: { username },
  select: {                          // ALLOW-LIST. Adding a column is a decision, not an accident.
    id: true, name: true, username: true, displayUsername: true,
    avatarUrl: true, bio: true, website: true, location: true,
    interests: true, socialLinks: true, createdAt: true,
  },
});
```

| Never public | Why |
|---|---|
| `email` | The identifier that logs you in. Publishing it is handing out half the credentials, plus a spam target. |
| `birthDate` | Name + DOB is an identity-theft primitive and a recovery answer on other sites (auth.md §5) |
| `phoneNumber` | Friends only, and only when verified |
| `twoFactorEnabled` | Tells an attacker which accounts are the soft targets |
| `isOnline`, `lastSeenAt` | Only per the privacy toggle (§6) |
| Anything from `Account`, `Session`, `TwoFactor` | Hashes, tokens, and secrets. Never joined, never selected. |

**The rule to remember:** an allow-list fails closed. Add a private column later and it stays private by default. A block-list fails open — the day you forget to add a field to it, it ships to the public.

---

## 12. Endpoints & Rate Limits

| Route | Does | Limit |
|---|---|---|
| `GET /api/users/:username` | Public profile, allow-listed | 60/min per IP |
| `PATCH /api/me` | Update everyday fields (§3) | 30/hour per user |
| `POST /api/me/username` | Change username | **1 per 30 days**, 10/hour per user |
| `GET /api/username-available` | Live availability | 30/min per IP *(auth.md §10)* |
| `POST /api/upload` | Avatar image | 5/hour per user |
| `POST /api/me/email/start` | Send OTP to the new address | 3/hour per user |
| `POST /api/me/email/verify` | Confirm the code | 10/hour per user |
| `POST /api/me/phone/start` | Send SMS OTP | **3/day per user** — SMS costs real money |
| `POST /api/me/phone/verify` | Confirm the code | 10/hour per user |
| `PATCH /api/me/privacy` | Update toggles | 30/hour per user |
| `POST /api/me/confirm-password` | The §9 gate | 5/15min per user |
| `POST /api/me/deactivate` | Hide the account | 5/day per user |
| `POST /api/me/delete` | Schedule deletion | 3/day per user |

Same rate-limit store as auth.md §10, so the limits behave identically everywhere.

---

## 13. Pros and Cons

### Pros

| | |
|---|---|
| **Nothing here can block the app** | Every field is optional. Skip the whole thing forever and ChatSphere still works. |
| **Two surfaces, no accidental leaks** | The public endpoint is an allow-list; a new private column is private by default. |
| **One OTP shape everywhere** | 6 digits · 5 minutes · 3 attempts · hashed · single-use — signup, email change, phone. One mental model, one set of bugs. |
| **Dangerous actions feel dangerous** | The §9 gate is the difference between "oops" and "confirmed". |
| **Deletion has an undo** | 30 days and "log in to cancel" fixes both rage-quits and hijacked sessions. |
| **Privacy is enforced server-side** | Hidden buttons are decoration; the API is the control. |
| **No new infrastructure** | Reuses Cloudinary, the session table, the rate limiter, the audit log, and the OTP pattern. |

### Cons

| | Mitigation |
|---|---|
| **SMS costs money** | Phone verification is opt-in and capped at 3/day per user. Skip the whole feature until someone asks for it — nothing else depends on it. |
| **Username changes break shared links** | Anyone holding `/u/oldname` gets a 404 after 30 days. Accepted: one change per month keeps it rare. |
| **Anonymized-not-erased messages** | Full erasure is a manual job. Documented honestly rather than over-promised. |
| **Another table to sweep** | The nightly job that clears `PendingRegistration` also handles `PendingContactChange` and scheduled deletions — one cron, three `DELETE`s. |
| **The 5-minute gate can annoy** | Only fires on the eight actions in §9, and once per five minutes. Everyday editing never sees it. |
| **Privacy toggles add query complexity** | Every search and profile read now considers a relationship. Keep it in one shared helper so it can't drift. |

---

## 14. Launch Checklist

**Public exposure**
- [ ] `GET /api/users/:username` returns **no** `email`, `birthDate`, `phoneNumber`, or `twoFactorEnabled` — check the raw JSON, not the UI
- [ ] Every profile query uses `select`, never `User.*`
- [ ] Bio, location, and custom gender render as text, never as HTML
- [ ] Website links carry `rel="nofollow noopener noreferrer"`

**Avatar**
- [ ] MIME sniffed from magic bytes, not the filename
- [ ] EXIF stripped — upload a geotagged phone photo and confirm the coordinates are gone
- [ ] Remove-avatar falls back to the initials circle, never a broken image

**Email & phone**
- [ ] Changing email sends the alert to the **old** address
- [ ] Changing email revokes all other sessions
- [ ] `grep -r "phoneVerified"` touches **no** file that issues a session, resets a password, or handles 2FA

**Privacy**
- [ ] Each toggle enforced in the API — verified by calling the route directly with the button hidden
- [ ] "Nobody" for online status also hides *others'* status from you
- [ ] Existing friends can still message someone set to "Nobody"

**Account lifecycle**
- [ ] Deactivate revokes every session and hides the profile
- [ ] Logging in during the 30 days cancels a scheduled deletion
- [ ] After anonymization, the user's messages read as "Deleted User" and the thread is still intact
- [ ] Nightly sweep covers `PendingContactChange` and due deletions

**Gate**
- [ ] All eight §9 actions demand the password when the 5-minute window has lapsed
- [ ] Five wrong password confirmations locks the gate for 15 minutes

---

## Summary

**Public** (`/u/username`): avatar, name, @username, bio, website, location, interests, social links — filtered by the privacy toggles.

**Private, always:** email, date of birth, phone number, 2FA status, sessions, everything in `Account`.

**Free to edit:** name, bio, website, location, gender, interests, socials, avatar, privacy toggles.

**Needs your password:** email, phone, password, 2FA, log out everywhere, deactivate, delete.

**Why it's safe:** the public endpoint is an allow-list that fails closed, every dangerous action passes a 5-minute password gate, an email change warns the old inbox and kills every other session, deletion waits 30 days with a one-step undo, and a verified phone number grants exactly nothing — because auth.md said so, and this document doesn't get to overrule it.
