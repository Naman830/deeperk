import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../src/env";
import { db, schema, ops } from "../src/db";
import { createUser, newApi, type FixtureUser } from "../src/fixtures";
import { listAvatarAssets, destroyAvatarPrefix } from "../src/cloudinary";
import { isCronAuthorized } from "@/lib/jobs/cron-auth";

/**
 * The two nightly cron routes (web/src/app/api/cron/*), driven end to end
 * against the REAL Neon DB and the REAL Cloudinary account. Two standing
 * cautions:
 *
 * - Assert only on fixture-owned rows and `avatars/<fixtureId>/` prefixes, and
 *   use >= for the report's global counters — a genuinely-due real row being
 *   anonymized mid-test is the job doing its production job, not a bug.
 * - THE LEAK TRAP: cleanupAll() discovers fixtures via `username LIKE
 *   'zz.e2e.%'`. The anonymizer rewrites the username, making the fixture
 *   invisible to cleanup FOREVER. The afterAll below restores every fixture's
 *   identifying fields by captured id — it must stay unconditional.
 */

// sharp is hoisted at the repo root (web's dependency) — resolved via require
// because the tests workspace doesn't declare it.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = require("sharp");

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 40, g: 90, b: 160 } } })
    .png()
    .toBuffer();
}

const cronHeaders = { authorization: `Bearer ${config.cronSecret}` };
const runner = newApi();
const DAY_MS = 24 * 60 * 60 * 1000;

let doomed: FixtureUser; // stamped past-due → anonymized
let future: FixtureUser; // stamped in the future → untouched
let cancelled: FixtureUser; // stamped past-due, then logs in → untouched
let holder: FixtureUser; // owns one expired + one live reserved_username row
let viewer: FixtureUser; // independent session for public-profile 404s
let pic1: FixtureUser; // sweep: fresh orphan
let pic2: FixtureUser; // sweep: current avatar, must survive
let doomedAvatarId: string;
let orphanId: string;
let keptId: string;
let expiredHold: string;
let liveHold: string;

async function userRow(id: string) {
  const rows = await db.select().from(schema.user).where(ops.eq(schema.user.id, id));
  return rows[0] ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function countFor(table: any, column: any, id: string): Promise<number> {
  const rows = await db.select().from(table).where(ops.eq(column, id));
  return rows.length;
}

async function uploadAvatar(fixture: FixtureUser): Promise<string> {
  const form = new FormData();
  form.append("avatar", new File([new Uint8Array(await makePng())], "avatar.png", { type: "image/png" }));
  const res = await fixture.api.post("/api/me/avatar", { form });
  expect(res.status).toBe(200);
  return res.body.avatarPublicId as string;
}

/** Cloudinary's Admin listing lags writes by a moment — poll, don't assume. */
async function pollAssets(userId: string, done: (ids: string[]) => boolean, ms = 20_000): Promise<string[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const ids = await listAvatarAssets(userId);
    if (done(ids) || Date.now() > deadline) return ids;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

describe.skipIf(!config.cronSecret)("nightly cron jobs", () => {
  beforeAll(async () => {
    doomed = await createUser("crd");
    future = await createUser("crf");
    cancelled = await createUser("crc");
    holder = await createUser("crh");
    viewer = await createUser("crv");
    pic1 = await createUser("crp1");
    pic2 = await createUser("crp2");

    // doomed gets one of everything the anonymizer must scrub.
    doomedAvatarId = await uploadAvatar(doomed);
    const links = await doomed.api.patch("/api/me", {
      json: { socialLinks: [{ platform: "site", url: "https://example.com" }] },
    });
    expect(links.status).toBe(200);
    const privacy = await doomed.api.patch("/api/me/privacy", { json: { discoverable: "NOBODY" } });
    expect(privacy.status).toBe(200);
    await db.insert(schema.pendingContactChange).values({
      userId: doomed.userId,
      type: "EMAIL",
      newValue: `${doomed.username}.new@chatsphere-e2e.test`,
      otpHash: "deadbeef",
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });
    await db.insert(schema.reservedUsername).values({
      username: `${doomed.username}.old`,
      userId: doomed.userId,
      expiresAt: new Date(Date.now() + 20 * DAY_MS),
    });

    // The global reserved_username sweep: one row past expiry, one live.
    expiredHold = `${holder.username}.exp`;
    liveHold = `${holder.username}.live`;
    await db.insert(schema.reservedUsername).values([
      { username: expiredHold, userId: holder.userId, expiresAt: new Date(Date.now() - 60 * 1000) },
      { username: liveHold, userId: holder.userId, expiresAt: new Date(Date.now() + 20 * DAY_MS) },
    ]);

    // Sweep fixtures: two real uploads; pic1's DB pointer is nulled so its
    // asset becomes a genuine fresh orphan.
    orphanId = await uploadAvatar(pic1);
    keptId = await uploadAvatar(pic2);
    await db.update(schema.user).set({ avatarPublicId: null }).where(ops.eq(schema.user.id, pic1.userId));

    // Stamps go in via direct DB (the 30-search-block precedent): any
    // authenticated request from the stamped user would trip getSession's
    // cancel-on-login and clear them.
    await db
      .update(schema.user)
      .set({ deletionScheduledAt: new Date(Date.now() - DAY_MS) })
      .where(ops.eq(schema.user.id, doomed.userId));
    await db
      .update(schema.user)
      .set({ deletionScheduledAt: new Date(Date.now() + DAY_MS) })
      .where(ops.eq(schema.user.id, future.userId));
    await db
      .update(schema.user)
      .set({ deletionScheduledAt: new Date(Date.now() - DAY_MS) })
      .where(ops.eq(schema.user.id, cancelled.userId));

    // The cancel path: one authenticated request clears the stamp.
    const me = await cancelled.api.get("/api/me");
    expect(me.status).toBe(200);
    const row = await userRow(cancelled.userId);
    expect(row.deletionScheduledAt).toBeNull();
  });

  afterAll(async () => {
    // THE LEAK TRAP mitigation — restore identifying fields by captured id so
    // cleanupAll's zz.e2e.% discovery sees every fixture again. Idempotent
    // when anonymization never ran (writes the same values back).
    for (const fixture of [doomed, future, cancelled, holder, viewer, pic1, pic2]) {
      if (!fixture) continue;
      await db
        .update(schema.user)
        .set({
          username: fixture.username,
          displayUsername: fixture.username,
          email: fixture.email,
          deletionScheduledAt: null,
        })
        .where(ops.eq(schema.user.id, fixture.userId));
    }
    for (const fixture of [doomed, pic1, pic2]) {
      if (fixture) await destroyAvatarPrefix(fixture.userId);
    }
  });

  it("both routes refuse a missing or wrong secret with 403", async () => {
    const anonymous = newApi();
    for (const path of ["/api/cron/anonymize-accounts", "/api/cron/sweep-avatars"]) {
      const missing = await anonymous.get(path);
      expect(missing.status).toBe(403);
      expect(missing.body).toEqual({ error: "Forbidden" });
      const wrong = await anonymous.get(path, { headers: { authorization: "Bearer nope" } });
      expect(wrong.status).toBe(403);
      expect(wrong.body).toEqual({ error: "Forbidden" });
    }
  });

  it("isCronAuthorized fails closed when CRON_SECRET is unset (unit)", () => {
    // Not testable over HTTP — the dev server's env is baked at boot. The `@`
    // alias import runs the same code in this process instead.
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const request = new Request("http://localhost/api/cron/anonymize-accounts", {
        headers: { authorization: `Bearer ${prev ?? "anything"}` },
      });
      expect(isCronAuthorized(request)).toBe(false);
    } finally {
      if (prev !== undefined) process.env.CRON_SECRET = prev;
    }
  });

  it("anonymizes a due account end to end", async () => {
    const res = await runner.get("/api/cron/anonymize-accounts", { headers: cronHeaders });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.anonymized).toBeGreaterThanOrEqual(1);

    // The row itself: every value is derived from the user id, so the expected
    // strings are computable here.
    const hex = createHash("sha256").update(doomed.userId).digest("hex").slice(0, 16);
    const row = await userRow(doomed.userId);
    expect(row.username).toBe(`deleted.${hex}`);
    expect(row.displayUsername).toBe(`deleted.${hex}`);
    expect(row.email).toBe(`deleted.${hex}@anonymized.invalid`);
    expect(row.name).toBe("Deleted User");
    expect(row.firstName).toBe("Deleted");
    expect(row.lastName).toBeNull();
    expect(row.bio).toBeNull();
    expect(row.avatarPublicId).toBeNull();
    expect(row.emailVerified).toBe(false);
    expect(row.birthDate).toBe("1970-01-01");
    expect(row.deactivatedAt).not.toBeNull();
    expect(row.deletionScheduledAt).toBeNull();

    // Sessions are revoked — the fixture's cookie jar is now worthless.
    const me = await doomed.api.get("/api/me");
    expect(me.status).toBe(401);

    // Companion rows are scrubbed explicitly (they'd only CASCADE on a hard
    // delete that never happens).
    expect(await countFor(schema.session, schema.session.userId, doomed.userId)).toBe(0);
    expect(await countFor(schema.account, schema.account.userId, doomed.userId)).toBe(0);
    expect(await countFor(schema.socialLink, schema.socialLink.userId, doomed.userId)).toBe(0);
    expect(await countFor(schema.privacySettings, schema.privacySettings.userId, doomed.userId)).toBe(0);
    expect(await countFor(schema.pendingContactChange, schema.pendingContactChange.userId, doomed.userId)).toBe(0);
    expect(await countFor(schema.reservedUsername, schema.reservedUsername.userId, doomed.userId)).toBe(0);

    // Global reserved_username sweep: expired gone, live kept.
    const holds = await db
      .select({ username: schema.reservedUsername.username })
      .from(schema.reservedUsername)
      .where(ops.eq(schema.reservedUsername.userId, holder.userId));
    const names = holds.map((h: { username: string }) => h.username);
    expect(names).not.toContain(expiredHold);
    expect(names).toContain(liveHold);
    expect(res.body.reservedUsernamesSwept).toBeGreaterThanOrEqual(1);

    // The avatars/<id>/ folder is destroyed (best-effort in the job, but with
    // working credentials it must actually happen).
    const assets = await pollAssets(doomed.userId, (ids) => ids.length === 0);
    expect(assets).toEqual([]);
    expect(doomedAvatarId).toContain(doomed.userId); // sanity: we swept OUR prefix

    // Hidden from other users even though deletionScheduledAt is now null —
    // pins deactivatedAt as the permanent marker.
    const publicView = await viewer.api.get(`/api/users/deleted.${hex}`);
    expect(publicView.status).toBe(404);
  });

  it("leaves future-dated and cancelled stamps untouched (predicate direction pin)", async () => {
    // A now-30d predicate instead of stamp<now would have anonymized `future`
    // never and `doomed` a month late; this pins the direction both ways.
    const futureRow = await userRow(future.userId);
    expect(futureRow.username).toBe(future.username);
    expect(futureRow.deletionScheduledAt).not.toBeNull();

    const cancelledRow = await userRow(cancelled.userId);
    expect(cancelledRow.username).toBe(cancelled.username);
    expect(cancelledRow.deactivatedAt).toBeNull();
  });

  it("re-running the anonymizer is a byte-identical no-op for finished rows", async () => {
    const before = await userRow(doomed.userId);
    const res = await runner.get("/api/cron/anonymize-accounts", { headers: cronHeaders });
    expect(res.status).toBe(200);
    const after = await userRow(doomed.userId);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it("sweep keeps fresh orphans and current avatars under the default cutoff", async () => {
    // Both uploads must be visible to the Admin API before sweeping.
    await pollAssets(pic1.userId, (ids) => ids.includes(orphanId));
    await pollAssets(pic2.userId, (ids) => ids.includes(keptId));

    const res = await runner.get("/api/cron/sweep-avatars", { headers: cronHeaders });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Global counters — other prefixes are in scope, so >= only.
    expect(res.body.keptRecent).toBeGreaterThanOrEqual(1);

    expect(await listAvatarAssets(pic1.userId)).toContain(orphanId); // fresh orphan: protected
    expect(await listAvatarAssets(pic2.userId)).toContain(keptId);
  });

  it("sweep deletes aged orphans via the secret-gated cutoff override, never current avatars", async () => {
    const bad = await runner.get("/api/cron/sweep-avatars?recentCutoffHours=abc", { headers: cronHeaders });
    expect(bad.status).toBe(400);

    const res = await runner.get("/api/cron/sweep-avatars?recentCutoffHours=0", { headers: cronHeaders });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deleted).toBeGreaterThanOrEqual(1);
    expect(res.body.keptCurrent).toBeGreaterThanOrEqual(1);

    const gone = await pollAssets(pic1.userId, (ids) => !ids.includes(orphanId));
    expect(gone).not.toContain(orphanId);
    expect(await listAvatarAssets(pic2.userId)).toContain(keptId); // current: kept even at cutoff 0
  });
});
