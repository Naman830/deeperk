# Deploying ChatSphere — free tier, step by step

This guide takes a fresh clone of this repo to a live, publicly reachable deployment for **$0/month**. It assumes nothing beyond a GitHub account and basic terminal use.

**The stack this guide produces:**

| Piece | Where | Free tier used |
|---|---|---|
| `web/` — Next.js app (UI + all `/api/*` routes) | [Vercel](https://vercel.com) | Hobby plan |
| `server/` — Socket.IO realtime server | [Render](https://render.com) | Free web service |
| Postgres database | [Neon](https://neon.tech) | Free plan |
| Transactional email (signup / password-reset OTPs) | [Brevo](https://www.brevo.com) | Free plan — 300 emails/day |
| Avatar & chat-media storage | [Cloudinary](https://cloudinary.com) | Free plan |

```
                       ┌─────────────────────────────┐
  browser ────────────►│  Vercel  (chatsphere.vercel.app)
                       │  Next.js: pages + /api/*    │
                       │  /socket.io/* ── rewrite ───┼──┐
                       └──────────────┬──────────────┘  │
                                      │ SOCKET_INTERNAL_URL
                                      ▼                 ▼
                       ┌─────────────────────────────────┐
                       │  Render  (chatsphere-socket.onrender.com)
                       │  Express + Socket.IO            │
                       └──────────────┬──────────────────┘
                                      │
              Neon Postgres ◄─────────┴────────► (both talk to the same DB)
              Brevo / Cloudinary ◄── Vercel only
```

## Why this exact topology (read before changing it)

- **The browser never connects to the Render URL directly.** The session cookie is host-only (`chatsphere.vercel.app`), so a socket connection to `*.onrender.com` would arrive with **no cookie** and `server/src/socket/auth.js` would reject every handshake. Instead, `web/next.config.ts` has a rewrite that proxies `/socket.io/*` from the web origin to the socket server — the browser talks to one origin only, and the cookie flows. This is the topology `server/src/socket/auth.js` documents as the only correct one.
- **Consequence: no WebSocket upgrade in production.** Vercel rewrites cannot proxy a WebSocket upgrade, so engine.io's upgrade probe fails and the connection stays on **HTTP long-polling**. This is graceful and automatic — chat, presence and typing indicators all work, with slightly more request overhead. Do not "fix" this by pointing `NEXT_PUBLIC_SOCKET_URL` at the Render URL; that breaks auth entirely (see above).
- **Exactly one socket server instance.** Presence tracking is in-memory and the boot-time "everyone offline" reset assumes a single process (`SOCKET_SINGLE_INSTANCE=true`). Render free runs one instance — fine. Never scale it to 2+ without the Redis adapter work described in `server/src/env.js`.

---

## Step 0 — prerequisites

1. Fork or push this repo to your own GitHub account (Vercel and Render deploy from GitHub).
2. Create free accounts on Vercel, Render, Neon, Brevo, Cloudinary.
3. Generate **four secrets** locally and save them somewhere — you'll paste them into dashboards later:

   ```bash
   openssl rand -hex 32   # → BETTER_AUTH_SECRET
   openssl rand -hex 32   # → MEDIA_SIGNING_SECRET
   openssl rand -hex 32   # → INTERNAL_API_SECRET
   openssl rand -hex 32   # → CRON_SECRET (authorizes the nightly /api/cron/* jobs)
   ```

## Step 1 — Neon (database)

1. Create a Neon project (any region — pick one close to Render/Vercel regions you'll choose, e.g. `us-east`).
2. Copy the **connection string** (the pooled one is fine): `postgres://…neon.tech/…?sslmode=require`. This is your `DATABASE_URL` — the *same* value is used by web and server.
3. Push the schema from your machine:

   ```bash
   git clone <your fork> && cd webRtc_Project
   npm install
   echo 'DATABASE_URL=<your connection string>' > .env
   npx drizzle-kit push
   ```

   The spinner can sit **60–90 seconds with no output** on this driver — that's normal, not a hang. When it finishes, all 15 tables exist.

## Step 2 — Brevo (email)

1. **SMTP & API → API Keys tab → Generate a new API key** → this is `BREVO_API_KEY`. **It must start with `xkeysib-`.** The neighbouring *SMTP* tab issues `xsmtpsib-` keys for the SMTP relay; they look identical in length but the REST API rejects them with `401 "Key not found"`, which looks like a revoked key rather than the wrong kind. Verify with `curl -H "api-key: $BREVO_API_KEY" https://api.brevo.com/v3/account`.
2. **Senders, Domains & IPs → Senders → Add a sender.** Enter the address you want mail to come from (a plain Gmail address is fine — **no domain and no DNS records needed**), then enter the 6-digit code Brevo emails to it. Set `BREVO_FROM_EMAIL` to that address and `BREVO_FROM_NAME` to `ChatSphere`.
3. **Security → Authorised IPs — check this, it is NOT reliably off.** Brevo challenges calls from unrecognised IPs even on a fresh account with a valid key, answering `401 "We have detected you are using an unrecognised IP address ..."`. Authorise your IP at <https://app.brevo.com/security/authorised_ips> (Brevo usually emails you a link too).

> **⚠ This matters for production, not just local testing.** Vercel's egress IPs rotate and can't be allow-listed ahead of time, so **IP restriction must be disabled** on the Brevo account before deploying — otherwise sends fail intermittently with a 401 that looks identical to a bad API key.

> **⚠ Sender verification is not optional.** Until step 2 is done, Brevo refuses every send with a 400 and the signup UI shows a delivery error (the app maps failed sends to a 502 rather than pretending success).

> **Free-tier realities:** **300 emails/day**, which is ample for a portfolio deploy but is a hard daily cap — past it, sends fail and signup returns 502 until the counter resets. Unlike Resend's free tier, Brevo delivers to **any recipient**, so anyone can sign up. The trade-off is deliverability: mail sent from a `gmail.com` address carries Brevo's DKIM signature rather than Gmail's, so it isn't DMARC-aligned for `gmail.com` and lands in **Spam/Promotions** more often than a domain-aligned sender would. It is delivered, not rejected (`gmail.com` publishes `p=none`) — tell first-time users to check spam. Verifying a real domain in Brevo (needs a ~$10/yr domain) removes the caveat entirely; nothing in the code changes, only `BREVO_FROM_EMAIL`.

## Step 3 — Cloudinary (media)

From the Cloudinary dashboard copy three values: **cloud name**, **API key**, **API secret**. Use an unrestricted key, or a scoped one granted at least `create` + `read` — a key without `create` answers 403 on every upload while looking healthy otherwise.

> **⚠ The nightly cron jobs also use Cloudinary's Admin API** (listing assets by prefix, deleting orphans, destroying anonymized users' avatar folders). A scoped key that only allows `create`+`read` uploads may refuse those calls — the sweeps then answer 500 in the Vercel cron log while uploads keep working. An unrestricted key avoids the split-brain.

## Step 4 — Render (Socket.IO server)

Create **New → Web Service**, connect your GitHub repo, then:

| Setting | Value |
|---|---|
| Root Directory | *(leave empty — repo root; the server imports the root `db/` folder)* |
| Build Command | `npm ci --omit=dev` |
| Start Command | `node server/src/index.js` |
| Health Check Path | `/healthz` |
| Instance Type | Free |

> **Do not** use `npm start` in `server/` as the start command — it runs `node --env-file=.env`, and with no `.env` file on Render, Node refuses to start. Render injects env vars directly, so plain `node server/src/index.js` is correct (`PORT` is injected by Render and honored as a fallback for `SOCKET_PORT`).

Environment variables (Render dashboard → Environment):

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | your Neon connection string |
| `WEB_ORIGIN` | `https://<your-app>.vercel.app` *(fill after Step 5 if unsure; comma-separate multiple origins)* |
| `WEB_INTERNAL_URL` | `https://<your-app>.vercel.app` |
| `SOCKET_SINGLE_INSTANCE` | `true` |
| `MEDIA_SIGNING_SECRET` | the hex secret from Step 0 |
| `INTERNAL_API_SECRET` | the hex secret from Step 0 |
| `ICE_SERVERS` | *(optional — see "WebRTC calls: TURN" below)* JSON array of `{"urls": …}` objects handed to callers in signaling acks. Unset = Google STUN only. **Malformed JSON makes the server refuse to start** (a crash-loop on Render) — deliberate, so a typo'd TURN config can never silently degrade calls to STUN-only |
| `CALL_RING_TIMEOUT_MS` / `CALL_DISCONNECT_GRACE_MS` | *(optional)* ring timeout / mid-call reconnect grace; defaults 30000 / 15000 |

Deploy, then note your service URL, e.g. `https://chatsphere-socket.onrender.com`. Verify: opening `<render-url>/healthz` in a browser returns `{"ok":true,…}` (first hit after idle takes 30–60 s — see "Free-tier realities" below).

## Step 5 — Vercel (web app)

Create **Add New → Project**, import the same repo, then:

| Setting | Value |
|---|---|
| Framework Preset | Next.js (auto-detected) |
| Root Directory | `web` |
| "Include source files outside of the Root Directory" | **must be enabled** (Settings → Root Directory) — `web/` imports the repo-root `db/` folder; the build fails without it |

Environment variables (add for Production):

| Key | Value |
|---|---|
| `DATABASE_URL` | your Neon connection string (same as Render's) |
| `BETTER_AUTH_SECRET` | the hex secret from Step 0 |
| `BETTER_AUTH_URL` | `https://<your-app>.vercel.app` |
| `NEXT_PUBLIC_BETTER_AUTH_URL` | `https://<your-app>.vercel.app` |
| `BREVO_API_KEY` | from Step 2 |
| `BREVO_FROM_EMAIL` | the sender address you verified in Step 2 |
| `BREVO_FROM_NAME` | `ChatSphere` |
| `CLOUDINARY_CLOUD_NAME` | from Step 3 |
| `CLOUDINARY_API_KEY` | from Step 3 |
| `CLOUDINARY_API_SECRET` | from Step 3 |
| `NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME` | same cloud name again |
| `NEXT_PUBLIC_SOCKET_URL` | `https://<your-app>.vercel.app` — **the web origin itself, NOT the Render URL** (the `/socket.io/` rewrite proxies it; see "Why this topology") |
| `SOCKET_INTERNAL_URL` | `https://<your-service>.onrender.com` — the Render URL (used server-side, and by the rewrite) |
| `MEDIA_SIGNING_SECRET` | **identical** to Render's value — a mismatch rejects every media message |
| `INTERNAL_API_SECRET` | **identical** to Render's value |
| `CRON_SECRET` | the hex secret from Step 0 — Vercel Cron sends it as `Authorization: Bearer …` to the two nightly `/api/cron/*` routes; with it unset every cron request is refused (fail closed) and the jobs never run |

Leave `TRUSTED_PROXIES` **unset on Vercel** — Vercel overwrites `x-forwarded-for` with the real client IP, so the verbatim value is trustworthy. Set it (to your proxy's CIDRs) only on self-hosted deploys behind your own nginx/load balancer, otherwise IP-keyed rate limits are spoofable there.

Deploy. Note the production URL (`https://<your-app>.vercel.app`).

### Nightly cron jobs (run on Vercel, configured already)

`web/vercel.json` defines two Vercel Cron entries — `/api/cron/anonymize-accounts` (03:00 UTC: anonymizes accounts past their 30-day deletion window, sweeps expired username holds) and `/api/cron/sweep-avatars` (05:00 UTC: deletes orphaned Cloudinary avatar assets). Nothing to set up beyond the `CRON_SECRET` env var above; after the first deploy, confirm both appear under **Project → Settings → Cron Jobs**.

> **Hobby-plan cron realities:** jobs run **once per day at most** and the hour is approximate (up to ~1h of jitter) — both jobs are designed for exactly that cadence. Hobby also caps a project at **2 cron jobs**, and both slots are used. Each run's JSON report (`{"ok":true,"anonymized":…}`) lands in the function logs.

## Step 6 — close the loop

Go back to Render and set `WEB_ORIGIN` and `WEB_INTERNAL_URL` to the real Vercel URL from Step 5 (if you used a placeholder). Render redeploys automatically on env change. The startup log prints the allowed origins — check it matches.

## Step 7 — verify it works

1. `https://<render-url>/healthz` → `{"ok":true,…}`.
2. Open the Vercel URL → login page renders.
3. Sign up with any email address → OTP arrives (**check Spam** on the first one — see Step 2) → complete signup.
4. Open a second browser (or incognito) with a second account (plus-addressing), start a direct chat, and send messages both ways — they should appear **live without refreshing**. In DevTools → Network you'll see `socket.io` long-polling requests against your Vercel origin; that's expected (no WebSocket — see "Why this topology").
5. Upload an avatar in Settings → Profile (keep it under ~4 MB — see below).

## Free-tier realities (leave these documented for users)

- **Cold starts:** Render free spins the socket server down after ~15 min idle; the next visitor's chat takes 30–60 s to connect while it boots (messages still send/load via the Vercel API routes — only realtime delivery waits). Neon also autosuspends compute after inactivity; the first query pays ~0.5–1 s. Acceptable for a demo. *Optional keep-warm:* a free monitor (cron-job.org or UptimeRobot) hitting `<render-url>/healthz` every 10 minutes prevents spin-down and fits within Render's 750 free instance-hours/month for a single service.
- **Vercel's ~4.5 MB request-body cap** rejects uploads near the app's own 5 MB limit before the app ever sees them. Large avatars/chat media fail at the edge with a platform error; most photos are smaller. (Self-hosting the web app is the only free way around this.)
- **Email is capped at 300/day** on Brevo's free plan, and mail from a domain-less sender often lands in Spam (Step 2 note).
- **One socket instance only** — never scale the Render service horizontally as configured.
- **Deploys are automatic**: pushing to `main` redeploys Vercel; Render redeploys on push too (both watch the GitHub repo).

## WebRTC calls: TURN is a config-only deploy step

Calls are built and work out of the box on Google STUN — but STUN alone fails for the **~10–15 % of users behind strict/symmetric NATs** (the call rings, connects nothing, and times out after ~20 s with "Couldn't connect — check your network"). The fix is a TURN relay, and it is **one env var on Render, no code change, nothing on Vercel**:

1. Get free TURN credentials: **Cloudflare Calls TURN** (generous free egress) or **Metered Open Relay** (free tier, limited monthly relay bandwidth).
2. On Render, set `ICE_SERVERS` to a JSON array including both STUN and your TURN entry, e.g.:

   ```
   [{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:relay.example.com:443?transport=tcp","username":"…","credential":"…"}]
   ```

3. Save — Render redeploys, and every subsequent call hands the new servers to both peers in the signaling acks (`iceServers` ride the acks; clients never read an env var for this).

**Malformed JSON refuses to boot** rather than silently degrading to STUN-only — if Render crash-loops right after this change, the value doesn't parse (check the quotes your shell/dashboard may have mangled). This only affects media relay — signaling runs on the existing Render socket server at no extra cost.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Vercel build fails resolving `../../db/schema` | "Include source files outside of the Root Directory" is off |
| Render exits immediately: `.env` not found | Start command uses `npm start` instead of `node server/src/index.js` |
| Render log: `DATABASE_URL is not set — refusing to start` | Env var missing/typoed on Render |
| Socket connects locally but every production connection is rejected (`UNAUTHENTICATED`) | `NEXT_PUBLIC_SOCKET_URL` points at the Render URL instead of the Vercel origin — cookie never sent |
| Connections rejected with CORS/origin errors in the Render log | `WEB_ORIGIN` doesn't exactly match the Vercel URL (scheme + host, no trailing slash) |
| Media messages all rejected / 503 | `MEDIA_SIGNING_SECRET` differs between Vercel and Render (or is unset on one) |
| Signup says email delivery failed (502) | Sender not verified in Brevo (400 — Step 2), `BREVO_API_KEY` invalid or Authorized IPs enabled (401), or the 300/day quota is spent. The real cause is in the Vercel function log — the app logs it and returns a generic message |
| Avatar upload 503 | Cloudinary env vars missing; 403-on-upload means the API key lacks the `create` permission |
| Render crash-loops immediately after setting `ICE_SERVERS` | The value isn't valid JSON — the server refuses to start on purpose rather than silently running STUN-only |
| Calls ring but never connect on some networks, "Couldn't connect" after ~20 s | Strict/symmetric NAT and no TURN relay configured — see "WebRTC calls: TURN" above |
| Cron jobs listed in Vercel but every run logs 403 | `CRON_SECRET` unset (fail-closed) or differs from what Vercel Cron sends |
| First request after idle hangs ~1 min | Render cold start — expected on the free tier |
