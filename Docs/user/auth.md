# Authentication — How ChatSphere Signs People In

This document covers the entire auth system: the signup flow, what goes in the database (and what must never go in), how each attack is stopped, and the honest trade-offs.

**Design goal:** strong security that the user never has to think about. Every hardening layer here is invisible unless it's protecting you.

---

## Table of Contents

1. [The Flow at a Glance](#1-the-flow-at-a-glance)
2. [Why Better Auth](#2-why-better-auth)
3. [Step by Step — What Actually Happens](#3-step-by-step--what-actually-happens)
4. [The Database — What We Store](#4-the-database--what-we-store)
5. [What We Must NEVER Store](#5-what-we-must-never-store)
6. [Security — Attack by Attack](#6-security--attack-by-attack)
7. [Sessions, Cookies, and the Socket.IO Server](#7-sessions-cookies-and-the-socketio-server)
8. [The Three Strength Layers](#8-the-three-strength-layers)
9. [Field Rules](#9-field-rules)
10. [Rate Limits](#10-rate-limits)
11. [Pros and Cons](#11-pros-and-cons)
12. [Config Sketch](#12-config-sketch)
13. [Launch Checklist](#13-launch-checklist)

---

## 1. The Flow at a Glance

```
  Open App
     │
     ▼
  Enter Email ─────────────────────────────────┐
     │                                         │
     ▼                                         │  Server silently checks:
  "Code sent to your email"  ◄─────────────────┘  does this account exist?
     │                                            (the user is NEVER told)
     ▼
  Enter 6-digit OTP
     │
     ├─── account EXISTS ──►  Session created  ──►  Logged in. Done.
     │
     └─── account is NEW  ──►  continue below
                                   │
                                   ▼
                            Name  →  Username  →  Date of Birth  →  Password
                                   │
                                   ▼
                            Create Account  (User row is written HERE, not before)
                                   │
                                   ▼
                            Session cookie set  →  Auto-logged in
                                   │
                                   ▼
                            Complete Profile  (avatar, bio — skippable)
```

**Two things to notice:**

- **One question per screen.** Typing an email is easy. Filling a 6-field form is a wall. Progressive screens cut signup abandonment hard, and on a phone keyboard it's the difference between finishing and quitting.
- **Login and signup are the same door.** The user types their email and gets a code. They never pick "Sign In" vs "Sign Up" — the server figures it out. Fewer decisions, and it closes a security hole (see [§6](#user-enumeration)).

---

## 2. Why Better Auth

Better Auth is a self-hosted TypeScript auth library. User rows live in **our** Postgres, which matters enormously here: username search and friend requests are SQL `JOIN`s against the user table. With a hosted service (Clerk, Auth0) users live on *their* servers and we'd mirror them over webhooks — an extra moving part that silently drifts out of sync.

### What it gives us for free

| We need | Better Auth provides |
|---|---|
| Password hashing | scrypt with per-user salt, in the `Account` table |
| Sessions | `Session` table, signed httpOnly cookies, multi-device, revocable |
| OTP for existing users | `emailOTP` plugin — hashed codes, TTL, attempt caps |
| Unique usernames | `username` plugin |
| Extra profile columns | `user.additionalFields` — typed, not `JSON` soup |
| Rate limiting | built in, with per-route overrides |
| CSRF protection | Origin checks + `trustedOrigins` |
| 2FA | `twoFactor` plugin (TOTP + backup codes) |
| Breached-password blocking | `haveIBeenPwned` plugin |

### The one thing it can't do for us

Better Auth's `emailOTP` plugin verifies a code **against an existing User row**. Our flow verifies the email *before* the user exists — so for the **signup path only**, we write our own OTP using a `PendingRegistration` table.

That's roughly 150 lines across three endpoints. Everything else — login, sessions, passwords, 2FA, password reset, OTP for existing users — is Better Auth.

> **Why not hand-roll all of it?** Because we'd be writing session rotation, CSRF defence, timing-safe comparison, and scrypt tuning ourselves. More code, more risk, no benefit.

### The three endpoints we write

| Endpoint | Does |
|---|---|
| `POST /api/auth/start` | Takes an email. Always replies `{ ok: true }`. Internally routes to login-OTP or signup-OTP. |
| `POST /api/auth/verify` | Takes email + code. Existing user → logs them in. New → issues a registration token. |
| `POST /api/auth/complete` | Takes name, username, DOB, password + registration token → creates the account and signs them in. |

---

## 3. Step by Step — What Actually Happens

### Step 1 — Email entry

User types `naman@example.com` and hits Continue.

```
POST /api/auth/start   { email: "naman@example.com" }
      │
      ├─ normalise: trim + lowercase
      ├─ rate limit: 5 per hour per email, 20 per hour per IP
      ├─ SELECT id FROM "User" WHERE email = ...
      │
      ├─ FOUND ──────► Better Auth sends a sign-in OTP
      └─ NOT FOUND ──► INSERT PendingRegistration { email, otpHash, expiresAt }
                       send our own OTP

Response (both cases, identical):  200  { ok: true }
```

**The response is identical either way, on purpose.** If we replied "email already registered," anyone could paste a list of 10,000 emails and learn which ones have ChatSphere accounts. That list gets sold. See [§6](#user-enumeration).

### Step 2 — Sending the OTP

```ts
// One adapter. Dev prints, prod sends.
async function sendOTP(email: string, code: string) {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`\n📨 OTP for ${email}: ${code}\n`);
    return;
  }
  await resend.emails.send({
    from: 'ChatSphere <auth@chatsphere.app>',
    to: email,
    subject: `${code} is your ChatSphere code`,
    text: `Your code is ${code}. It expires in 5 minutes.\n\nIf you didn't request this, ignore this email.`,
  });
}
```

Dev prints to the terminal — no Resend account needed to build the whole flow. Production uses **Resend** (3,000 emails/month free). Swapping providers means editing this one function.

**Put the code in the subject line.** On a phone, the user sees `847213 is your ChatSphere code` in the notification and can type it without opening the email. Small detail, large drop-off difference.

### Step 3 — Verifying the OTP

```
POST /api/auth/verify   { email, code: "847213" }
      │
      ├─ look up the PendingRegistration (or Better Auth Verification) row
      ├─ expired?          → 400, delete the row
      ├─ attempts >= 3?    → 400, delete the row  ← burn it, don't just count
      ├─ timing-safe compare  hash(code)  vs  stored otpHash
      ├─ wrong?            → attempts++, 400
      └─ correct?          → DELETE the row immediately (single use)
```

Then it branches:

- **Existing user** → Better Auth creates a `Session`, sets the cookie. They're in. Flow over.
- **New user** → we set a short-lived **registration token** (httpOnly cookie, 15 min) that proves *"this browser verified this email."* Screens 4–7 are just form fields; nothing hits the User table yet.

### Steps 4–7 — Name, Username, Date of Birth, Password

Four screens, one field each. Validated live on the client for feel, re-validated on the server for safety (client validation is a convenience, never a control).

Only the **username** screen calls the server, to check availability as the user types — debounced 300ms, rate-limited, and it answers only `available: true/false` for the string typed. That's a deliberate, narrow exception to the no-enumeration rule: it leaks that a *username* is taken, which is public information anyway (usernames are searchable — that's the whole point of `@naman`). It never leaks emails.

The **password** screen shows a live strength meter and, on submit, checks the password against known breach corpora ([§8](#8-the-three-strength-layers)).

### Step 8 — Create Account

```
POST /api/auth/complete   { name, username, dateOfBirth, password }
                          + registration-token cookie
      │
      ├─ verify the registration token (signed, unexpired, matches a verified email)
      ├─ re-validate every field server-side
      ├─ age >= 13
      ├─ password not in the breach corpus
      │
      └─ auth.api.signUpEmail({
           email, password, name,
           username, dateOfBirth,
           autoSignIn: true          ← creates the session in the same call
         })
              │
              ├─ password → scrypt hash → Account table
              ├─ User row created, emailVerified = true   (we already proved it)
              ├─ Session row + httpOnly cookie
              └─ registration token cookie cleared
```

One database transaction, one response, user is logged in. **No "now please log in" screen** — being asked to sign in immediately after signing up is a small insult and a real drop-off point.

### Step 9 — Complete Profile

Avatar and bio. **Skippable**, and they can be edited forever. Nothing here is required, so nothing here can block someone from reaching the app.

---

## 4. The Database — What We Store

### `PendingRegistration` — ours, temporary

```prisma
model PendingRegistration {
  id         String   @id @default(cuid())
  email      String   @unique
  otpHash    String                            // SHA-256 of the code. NEVER the code.
  attempts   Int      @default(0)
  verifiedAt DateTime?                         // set once the code checks out
  expiresAt  DateTime                          // now + 15 min
  createdAt  DateTime @default(now())

  @@index([expiresAt])                         // for the cleanup sweep
}
```

Rows live for at most 15 minutes. A nightly job deletes anything expired:

```sql
DELETE FROM "PendingRegistration" WHERE "expiresAt" < NOW();
```

**Why a table and not just a JWT?** A JWT can't be invalidated after 3 wrong guesses. A row can. Attempt-counting requires server state — so we keep server state.

### `User` — the person

Better Auth's columns plus ours (matches the schema in the main README):

| Column | Notes |
|---|---|
| `id` | cuid |
| `email` | unique, stored lowercase |
| `emailVerified` | always `true` at creation — we verified before the row existed |
| `name` | display name, can be anything (`Naman 🚀`) |
| `username` | unique, **lowercase** — this is what search matches |
| `displayUsername` | what the user typed, e.g. `NamanK` — display only |
| `birthDate` | `DATE`. Private. Never returned by a public profile endpoint. |
| `avatarUrl`, `bio` | optional profile |
| `phoneNumber` | **optional, unverified profile field only.** Not an auth identifier. Not a login method. Not a recovery method. |
| `twoFactorEnabled` | boolean |
| `isOnline`, `lastSeenAt` | presence |

> **On `phoneNumber`:** it's a contact detail users may fill in, nothing more. Because it is never verified, it must never gate access to anything. Treating an unverified phone as an identity is how accounts get stolen.

### `Account` — credentials (Better Auth)

| Column | Notes |
|---|---|
| `userId` | owner |
| `providerId` | `"credential"` for password |
| `password` | **scrypt hash + per-user salt.** Never readable, never reversible. |

Passwords live here, *not* on `User`. That separation means a query that accidentally selects `User.*` can never leak a hash.

### `Session` — active logins (Better Auth)

| Column | Notes |
|---|---|
| `token` | long random value; the cookie carries this and nothing else |
| `userId`, `expiresAt` | 30 days, rolling — refreshed if used within 24h |
| `ipAddress`, `userAgent` | powers the "where you're logged in" screen and new-device alerts |

One row per device. Deleting a row logs that device out **instantly** — that's the whole reason we chose sessions over JWTs ([§7](#7-sessions-cookies-and-the-socketio-server)).

### `Verification` — OTPs for existing users (Better Auth)

Hashed codes with expiries, for OTP login and password reset.

### `TwoFactor` — second factor (Better Auth)

| Column | Notes |
|---|---|
| `secret` | TOTP seed, **encrypted at rest** with `BETTER_AUTH_SECRET` |
| `backupCodes` | 10 single-use codes, stored **hashed** — same rule as passwords |

### `AuthEvent` — our audit log

```prisma
model AuthEvent {
  id        String   @id @default(cuid())
  userId    String?                          // null for failed attempts on unknown emails
  type      String                           // login_ok | login_fail | otp_sent | password_changed | 2fa_enabled | ...
  ipAddress String?
  userAgent String?
  createdAt DateTime @default(now())

  @@index([userId, createdAt])
}
```

Cheap to write, invaluable when someone asks "was my account accessed?" Note it stores **event types, never credentials** — no emails typed, no codes, no passwords.

---

## 5. What We Must NEVER Store

| Never store | Why | What we do instead |
|---|---|---|
| **Plaintext passwords** | A database leak becomes an instant takeover of every account — and of users' *other* accounts, since people reuse passwords | scrypt hash + per-user salt |
| **Plaintext OTP codes** | Anyone with read access to the DB (or a leaked backup) can log in as anyone | SHA-256 of the code; compare hashes |
| **Reversible/encrypted passwords** | Encryption implies a key, and the key is on the same server | Hashing is one-way. There is no "recover password," only reset. |
| **Session tokens in logs** | Logs get shipped to third parties, indexed, and shared in screenshots | Never log cookie headers or `Authorization` |
| **Auth request bodies** | Would capture passwords and codes verbatim | Log route + status + userId only |
| **Session tokens in `localStorage`** | Any XSS reads it in one line of JS | httpOnly cookie — JavaScript literally cannot read it |
| **Password hints or security questions** | "Mother's maiden name" is on Facebook. They're a bypass around a strong password, not an addition to it. | Email OTP recovery |
| **Unhashed backup codes** | They *are* passwords — each one grants full access | Hash them, mark used on use |
| **Unencrypted TOTP secrets** | The secret generates every future code | Encrypted at rest |
| **Birth date on public profiles** | Combined with a name it's an identity-theft primitive, and it's used for account recovery elsewhere | Store it; never return it from public endpoints |
| **Anything in the cookie beyond an opaque token** | Cookies are visible to the user and to any browser extension | The cookie is a random string. All meaning lives in the DB. |

**One rule to remember:** if it can be used to *become* the user, it is either hashed or it isn't stored.

---

## 6. Security — Attack by Attack

### User Enumeration

**The attack:** feed a list of emails into the login form and record which ones say "account exists." Now you have a verified list of ChatSphere users — the raw material for phishing and credential stuffing.

**The defence:** `/api/auth/start` returns the identical `{ ok: true }` for every email, existing or not. The user always sees "check your email." Existing users get a login code, new users get a signup code — the browser can't tell the difference. We also pad the response to a floor of ~200ms so *timing* doesn't leak it either (a DB hit is measurably slower than no DB hit).

**Cost:** typing an already-registered email during signup sends a login code instead of a signup code, which is very mildly surprising. Worth it.

### OTP Brute Force

**The attack:** a 6-digit code is one of a million. Automate a million guesses.

**The defence, layered:**

| Layer | Effect |
|---|---|
| 3 attempts, then the code is **deleted** | Attacker gets 3 shots out of 1,000,000 per code — a 0.0003% chance |
| 5-minute expiry | The window is tiny |
| Single use — deleted on success | No replay |
| Rate limit on *sending* | Can't request 1,000 fresh codes to farm attempts |
| Timing-safe comparison | Byte-by-byte timing can't reveal a partially-correct prefix |

Deleting the code after 3 failures (rather than just counting) matters: it forces the attacker back through the send-rate-limit every single time.

### Credential Stuffing

**The attack:** the most common real-world account takeover. Take username/password pairs from some *other* site's breach and replay them here, because ~65% of people reuse passwords.

**The defence:** the breached-password check ([§8](#8-the-three-strength-layers)) means a password that appeared in a known breach can't be set here at all. Plus per-account rate limiting, plus optional 2FA, plus an email alert on new-device login so the user finds out immediately.

### Password Brute Force

Rate limited per account **and** per IP with exponential backoff. Per-account alone lets an attacker spread across many accounts from one machine; per-IP alone is defeated by a proxy pool. Both together are what actually works.

### Password Database Leak

Even with the whole `Account` table, an attacker has **scrypt** hashes. scrypt is deliberately memory-hard — it needs a large block of RAM per guess, which is exactly what GPUs and ASICs are bad at. Cracking rates drop from billions/second (as with plain SHA-256) to thousands. Per-user salts mean rainbow tables are useless and every password must be attacked individually.

### Session Hijacking

| Cookie flag | Stops |
|---|---|
| `httpOnly` | JavaScript reading the token — this is what makes XSS non-fatal for sessions |
| `Secure` | Transmission over plain HTTP |
| `SameSite=Lax` | The cookie riding along on cross-site requests (CSRF) |
| Signed | Client-side tampering |

Plus: sessions are revoked on password change (all *other* devices), the session token rotates on privilege changes, and the user can kill any device from the sessions screen.

### CSRF

`SameSite=Lax` blocks the cookie on cross-site POSTs, and Better Auth checks the `Origin` header against `trustedOrigins`. Two independent controls, because one browser quirk shouldn't be the whole defence.

### XSS

The session token is unreachable from JavaScript (`httpOnly`), so even a successful XSS can't steal a session for offline reuse. React escapes rendered content by default, and a Content-Security-Policy header limits what injected script could do. **We never put a token in `localStorage`** — the single most common way apps turn an XSS into a permanent account takeover.

### Abandoned Signups

Someone verifies an email and closes the tab. Because the `User` row isn't written until the final step, there's no half-built account polluting search results or friend queries. The `PendingRegistration` row expires in 15 minutes and gets swept nightly. Zero cleanup logic in the application code.

### Underage Signups

Date of birth is validated server-side for 13+ (client validation is a hint, not a control). The check lives at `/api/auth/complete`, which is the only path that can create a user.

---

## 7. Sessions, Cookies, and the Socket.IO Server

### We use database sessions, not JWTs

Your flow said "JWT/Session." We chose **sessions**, deliberately.

| | Database session | JWT |
|---|---|---|
| Revoke a device | Instant — delete the row | Impossible until it expires |
| "Log out everywhere" | One `DELETE` | Requires a blocklist, i.e. a database — so, a session |
| Cost per request | One indexed lookup (~1ms), cached 5 min | Zero |
| Right for us | ✅ | ❌ |

A JWT's whole selling point is avoiding the database. But we have **one** server and **one** Postgres, and a chat app needs "sign out my old laptop" to actually work. Paying 1ms for instant revocation is an obviously good trade at our scale. If ChatSphere ever splits into many services, revisit — not before.

### How the Socket.IO server on :4000 authenticates

The socket server and Next.js share one Postgres. Cookies are scoped to the parent domain, so the browser sends the same session cookie to both.

```
Browser opens the WebSocket
      │  (browser attaches the session cookie automatically)
      ▼
Socket.IO handshake middleware  (:4000)
      │
      ├─ parse the session cookie
      ├─ SELECT * FROM "Session" WHERE token = ... AND "expiresAt" > NOW()
      │
      ├─ no valid row  →  reject the connection
      └─ valid         →  socket.data.userId = session.userId
                          join room `user:{userId}`
```

Two consequences worth naming:

- **Every socket event is trusted.** `socket.data.userId` came from the database, not from the client. A client claiming `{ from: "someone-else" }` in a message payload is ignored — we use `socket.data.userId`, always. This is the single most important rule in the socket server.
- **Revocation reaches sockets too.** Deleting a session and disconnecting its socket logs the device out of chat *and* real-time simultaneously.

### Session settings

| Setting | Value | Why |
|---|---|---|
| Expiry | 30 days | A chat app you're logged out of weekly is a chat app you stop using |
| Rolling refresh | if used within 24h | Active users effectively never get logged out |
| Cookie cache | 5 minutes | Cuts session lookups to roughly one per 5 min per user |
| On password change | revoke all *other* sessions | Changing a password after a scare must actually kick the intruder |

---

## 8. The Three Strength Layers

This is what makes it strong auth rather than normal auth. **All three are invisible to users who don't need them.**

### Layer 1 — Breached-Password Blocking (always on)

When a password is set, its SHA-1 is computed and only the **first 5 characters** are sent to the Have I Been Pwned range API. That prefix matches ~800 hashes; we scan them locally for the rest. The password — and even its full hash — never leaves our server. This is *k-anonymity*.

```
Password "chatsphere2024"
      │
      ├─ SHA-1  → 8BE3C9...          (stays on our server)
      ├─ send prefix "8BE3C"          (matches ~800 hashes, tells them nothing)
      ├─ receive ~800 suffixes
      └─ found locally? → "This password has appeared in a data breach. Please choose another."
```

**Why this is the highest-value control here:** it kills credential stuffing — the attack that actually takes over accounts — at the source. `Tr0ub4dor&3` passes every complexity rule ever written and is in every breach corpus. Length plus a breach check beats symbol requirements, which is exactly what NIST 800-63B now recommends.

**Fail-open:** if the HIBP API is down, we allow the password rather than block signups. Availability of the site outweighs a check the user can be nudged on later.

### Layer 2 — TOTP Two-Factor (opt-in)

Available in Settings, off by default. Enabling it:

```
1. Confirm current password                    ← so a hijacked session can't enable 2FA and lock the owner out
2. Scan the QR code with Google Authenticator / Authy / 1Password
3. Type a code to prove it works               ← never enable before this succeeds
4. Show 10 backup codes  →  "Save these now"   ← shown exactly once
```

Afterwards, login is `email → password → 6-digit app code`. The TOTP secret is encrypted at rest; backup codes are hashed and single-use.

**The critical detail:** step 3 is non-negotiable. Enabling 2FA before confirming a working code is how people permanently lock themselves out — and account recovery for a 20-user app is *you*, manually, at 2am.

### Layer 3 — Device Sessions + Login Alerts (always on)

**Settings → Security** lists every active session: device, browser, approximate location from IP, last active. Each has a **Log out** button, plus **Log out everywhere else**.

When a session is created from an unrecognised device, we email:

> New sign-in to ChatSphere
> Chrome on Windows · Delhi, India · 31 Jul 2026, 4:12 PM
> Not you? [Secure your account] — this logs out every device and forces a password reset.

**Why this earns its place:** it's the only layer that catches a *successful* breach. The other two prevent; this one detects and gives the user a one-click undo. It's also mostly UI over data the `Session` table already holds.

### Not included, and why

| Skipped | Reason |
|---|---|
| **Passkeys (WebAuthn)** | Genuinely the strongest and easiest option, but adds cross-browser edge cases and a fallback path to build and document. Best candidate for the next iteration. |
| **SMS OTP** | Phone is dropped from auth entirely. SMS is also the weakest common second factor — SIM swapping is a real, cheap attack — and it costs money per message. |
| **Password complexity rules** | Forced symbols produce `Password1!` and a sticky note. Length + the breach check is measurably stronger. |
| **Forced password rotation** | NIST explicitly advises against it: it produces `Summer2026`, then `Summer2027`. |
| **CAPTCHA** | Rate limiting handles our threat level at 20 users. Add it if bot signups ever appear. |

---

## 9. Field Rules

| Field | Rules | Reasoning |
|---|---|---|
| **Email** | Valid format, lowercased, trimmed, unique | Case-insensitive storage stops `Naman@` and `naman@` becoming two accounts |
| **Name** | 1–50 chars, any Unicode, emoji allowed | It's a display name. Rejecting `李明` or `Naman 🚀` is a bug, not a security control. |
| **Username** | 3–20 chars, `a–z 0–9 . _`, no leading/trailing dot, no consecutive dots, reserved-word blocklist | Stored lowercase in `username`, typed form kept in `displayUsername`. Reserved list: `admin`, `support`, `help`, `root`, `api`, `chatsphere`, `system`, `moderator` — so nobody can impersonate the platform. |
| **Date of Birth** | Real date, age ≥ 13, not in the future | 13 is the standard floor (COPPA). Checked server-side; the client check is only for feedback. |
| **Password** | 10–128 chars, no composition rules, breach-checked | Minimum 10 rather than 8 — the extra two characters are worth far more than a mandatory symbol. Max 128 prevents a megabyte password from burning CPU on scrypt. |

---

## 10. Rate Limits

| Route | Limit | Stops |
|---|---|---|
| `POST /auth/start` | 5/hour per email, 20/hour per IP | Email bombing and enumeration sweeps |
| `POST /auth/verify` | 10/hour per email | OTP brute force (on top of the 3-attempt burn) |
| `POST /auth/complete` | 3/hour per IP | Mass account creation |
| `POST /sign-in/email` | 10/15min per email + per IP | Password brute force |
| `GET /username-available` | 30/min per IP | Username enumeration scraping |
| `POST /forget-password` | 3/hour per email | Reset-email bombing |

Better Auth's built-in rate limiter covers its own routes; our three custom endpoints use the same store so the limits are consistent.

---

## 11. Pros and Cons

### Pros

| | |
|---|---|
| **Very low friction** | Returning users type an email and a code — no password to remember at all. One field per screen keeps mobile signup completable. |
| **No dead-end accounts** | The `User` row is written last, so search, friend requests, and the members list never see a half-built profile. |
| **Enumeration-proof entry** | Identical responses mean no scrapeable user list. |
| **Instant revocation** | Database sessions mean "log out everywhere" is one `DELETE` and it reaches the socket server too. |
| **Stops the attack that matters** | The breach check blocks credential stuffing — the actual cause of most real-world takeovers — before an account can exist. |
| **Detection, not just prevention** | Login alerts + device list give the user a one-click response to a successful breach. |
| **Data stays ours** | Self-hosted. `JOIN`s against the user table just work; no webhook mirroring, no drift, no per-MAU bill. |
| **Free at this scale** | Postgres + Resend's free tier. ₹0/month. |

### Cons

| | Mitigation |
|---|---|
| **Custom OTP code for the signup path** | ~150 lines we own and must test, because Better Auth's OTP plugin needs an existing user. Confined to three endpoints; existing-user OTP still uses the plugin. |
| **Email delivery is a hard dependency** | If Resend is down or the mail lands in spam, nobody can sign up or log in. Mitigation: SPF/DKIM/DMARC configured properly, the code in the subject line, and a visible "resend code" after 30 seconds. |
| **Session lookup per request** | ~1ms, and the 5-minute cookie cache removes most of them. Irrelevant at 20 users; revisit at 100k. |
| **A `PendingRegistration` table to sweep** | One `DELETE ... WHERE expiresAt < NOW()` on a nightly cron. |
| **Login-code surprise** | Entering an existing email during "signup" sends a login code. Accepted cost of closing enumeration; softened by wording the screen as "Enter the code we sent you." |
| **2FA lockout risk** | Real for a 20-user app with no support desk. Mitigated by forcing a successful code before enabling, and by 10 backup codes shown once with a hard "save these" step. |
| **Extra round trip on username** | One debounced availability call. Worth it — discovering `@naman` is taken *after* submitting the whole form is worse. |
| **No account recovery without email access** | If the user loses their inbox, the account is gone. Honest and unavoidable without a second verified factor — and we removed phone deliberately. Documented for users, not silently. |

---

## 12. Config Sketch

```ts
// web/src/lib/auth.ts
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { emailOTP, username, twoFactor, haveIBeenPwned } from 'better-auth/plugins';

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),

  emailAndPassword: {
    enabled: true,
    autoSignIn: true,            // signup returns a live session — no "now log in" screen
    minPasswordLength: 10,
    maxPasswordLength: 128,
  },

  user: {
    additionalFields: {
      birthDate:   { type: 'date',   required: true,  input: true },
      bio:         { type: 'string', required: false, input: false },
      avatarUrl:   { type: 'string', required: false, input: false },
      phoneNumber: { type: 'string', required: false, input: false },  // profile only, never auth
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 30,          // 30 days
    updateAge: 60 * 60 * 24,               // rolling refresh if used within 24h
    cookieCache: { enabled: true, maxAge: 300 },
  },

  advanced: {
    useSecureCookies: process.env.NODE_ENV === 'production',
    defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
  },

  trustedOrigins: [process.env.APP_URL!, process.env.SOCKET_URL!],

  rateLimit: {
    enabled: true,
    customRules: {
      '/sign-in/email':    { window: 900,  max: 10 },
      '/forget-password':  { window: 3600, max: 3  },
    },
  },

  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 300,             // 5 minutes
      allowedAttempts: 3,
      disableSignUp: true,        // OTP logs existing users in; it never creates accounts
      sendVerificationOTP: async ({ email, otp }) => sendOTP(email, otp),
    }),
    username(),
    twoFactor({ issuer: 'ChatSphere' }),
    haveIBeenPwned({
      customPasswordCompromisedMessage:
        'This password has appeared in a data breach. Please choose another.',
    }),
  ],
});
```

> Better Auth's option names move between minor versions — check the current docs when installing. The *shape* above is what we want regardless of what the keys end up being called.

### Environment variables

```bash
BETTER_AUTH_SECRET=      # openssl rand -base64 32 — also encrypts TOTP secrets. Never reuse the dev value.
BETTER_AUTH_URL=http://localhost:3000
DATABASE_URL=postgresql://...
RESEND_API_KEY=          # production only; dev prints OTPs to the terminal
```

---

## 13. Launch Checklist

**Secrets**
- [ ] Fresh `BETTER_AUTH_SECRET` in production — never the dev value
- [ ] Strong database password
- [ ] Secrets in the host's env store, never committed

**Cookies & transport**
- [ ] HTTPS everywhere; `useSecureCookies: true`
- [ ] `httpOnly` + `SameSite=Lax` confirmed in DevTools → Application → Cookies
- [ ] `trustedOrigins` lists exactly the real domains

**Email**
- [ ] Resend key set and the console fallback disabled in production
- [ ] SPF, DKIM, and DMARC records published — without them, OTPs land in spam and nobody can log in
- [ ] Sent yourself a real OTP to Gmail *and* Outlook and confirmed inbox delivery

**Rate limits**
- [ ] Every limit in [§10](#10-rate-limits) active and verified by actually tripping it

**Data hygiene**
- [ ] Nightly `PendingRegistration` sweep scheduled
- [ ] Auth request bodies excluded from logs — grep the logs for a test password and confirm zero hits
- [ ] Public profile endpoint returns no `email`, `birthDate`, or `phoneNumber`

**Flow**
- [ ] Signup, login, wrong OTP ×3, expired OTP, password reset, 2FA enable + login, backup-code login, and "log out everywhere" all tested end to end
- [ ] Socket handshake rejects a missing/invalid/expired cookie
- [ ] Confirmed that deleting a `Session` row disconnects that device's socket

---

## Summary

**Store:** email, hashed password, hashed OTPs, opaque session tokens, encrypted 2FA secrets, hashed backup codes, profile fields, an audit log of event *types*.

**Never store:** plaintext passwords, plaintext codes, tokens in logs or `localStorage`, security questions, unhashed backup codes.

**Why it's strong:** breached passwords can't be set, OTPs survive only 3 guesses for 5 minutes, sessions are revocable everywhere in one click, and a successful login from a new device emails the owner immediately.

**Why it's easy:** one field per screen, one door for login and signup, a code in the email subject line, no password needed to return, and no forced re-login after signing up.
