import { createRequire } from "node:module";
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "../src/env";
import { db, schema } from "../src/db";
import { eq } from "../src/cleanup";
import { readEmailChangeOtp } from "../src/otp";
import { createUser, newApi, PASSWORD, RUN_ID, USERNAME_PREFIX, type FixtureUser } from "../src/fixtures";

/**
 * Profile surface: /api/me (bundle, edits), privacy upsert, the username
 * cooldown + 30-day hold (owner exemption included), the real Cloudinary
 * avatar round trip, deletion scheduling + cancel-on-any-authenticated-request,
 * and the OTP-gated email change (mail-sending leg gated on TEST_EMAIL).
 *
 * Each traffic-heavy block gets its own fixture user so per-user buckets
 * (profile-update 30/hr, avatar-upload 10/hr, confirm-password 5/15min,
 * delete-account 3/day) never bleed between blocks.
 */

// sharp is hoisted at the repo root (web's dependency) — resolved via require
// so the harness adds no dependency of its own.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = require("sharp");

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 256, height: 256, channels: 3, background: { r: 9, g: 9, b: 9 } } })
    .png()
    .toBuffer();
}

describe("profile api", () => {
  describe("GET/PATCH /api/me", () => {
    let owner: FixtureUser;

    beforeAll(async () => {
      owner = await createUser("pra");
    });

    it("401 without a session", async () => {
      const res = await newApi().get("/api/me");
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("authenticated GET returns the own-profile bundle", async () => {
      const res = await owner.api.get("/api/me");
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(owner.username);
      expect(res.body.displayUsername).toBe(owner.username);
      expect(res.body.firstName).toBe("E2e");
      expect(res.body.lastName).toBe(owner.tag);
      expect(res.body.bio).toBeNull();
      expect(res.body.avatarPublicId).toBeNull();
      expect(res.body.socialLinks).toEqual([]);
      expect(res.body.deletionScheduledAt).toBeNull();
      // No privacy_settings row exists yet — the bundle must read as defaults.
      expect(res.body.privacy).toEqual({ discoverable: "EVERYONE", onlineStatus: "EVERYONE", profileDetails: "EVERYONE" });
    });

    it("PATCH bio + socialLinks round-trips on GET", async () => {
      const links = [
        { platform: "github", url: "https://github.com/example" },
        { platform: "x", url: "https://x.com/example" },
      ];
      const patch = await owner.api.patch("/api/me", { json: { bio: "Coffee, code, long walks.", socialLinks: links } });
      expect(patch.status).toBe(200);
      expect(patch.body).toEqual({ success: true });

      const res = await owner.api.get("/api/me");
      expect(res.body.bio).toBe("Coffee, code, long walks.");
      expect(res.body.socialLinks).toHaveLength(2);
      expect(res.body.socialLinks[0]).toMatchObject(links[0]);
      expect(res.body.socialLinks[1]).toMatchObject(links[1]);
      expect(typeof res.body.socialLinks[0].id).toBe("string");
    });

    it("socialLinks is a full replace, not a merge", async () => {
      const patch = await owner.api.patch("/api/me", {
        json: { socialLinks: [{ platform: "site", url: "https://example.com" }] },
      });
      expect(patch.status).toBe(200);

      const res = await owner.api.get("/api/me");
      expect(res.body.socialLinks).toHaveLength(1);
      expect(res.body.socialLinks[0]).toMatchObject({ platform: "site", url: "https://example.com" });
    });

    it("a 251-char bio → 400", async () => {
      const res = await owner.api.patch("/api/me", { json: { bio: "x".repeat(251) } });
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    });
  });

  describe("privacy settings", () => {
    let owner: FixtureUser;

    beforeAll(async () => {
      owner = await createUser("prq");
    });

    it("GET answers the defaults before any row exists", async () => {
      const res = await owner.api.get("/api/me/privacy");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ discoverable: "EVERYONE", onlineStatus: "EVERYONE", profileDetails: "EVERYONE" });
    });

    it("PATCH onlineStatus NOBODY upserts the first row", async () => {
      const patch = await owner.api.patch("/api/me/privacy", { json: { onlineStatus: "NOBODY" } });
      expect(patch.status).toBe(200);
      expect(patch.body).toEqual({ success: true });

      const res = await owner.api.get("/api/me/privacy");
      // Unspecified columns come from the DB defaults, not from the PATCH.
      expect(res.body).toEqual({ discoverable: "EVERYONE", onlineStatus: "NOBODY", profileDetails: "EVERYONE" });
    });

    it("an audience outside EVERYONE/NOBODY → 400", async () => {
      const res = await owner.api.patch("/api/me/privacy", { json: { onlineStatus: "FRIENDS" } });
      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe("string");
    });

    it("PATCH back to EVERYONE restores the default view", async () => {
      const patch = await owner.api.patch("/api/me/privacy", { json: { onlineStatus: "EVERYONE" } });
      expect(patch.status).toBe(200);

      const res = await owner.api.get("/api/me/privacy");
      expect(res.body).toEqual({ discoverable: "EVERYONE", onlineStatus: "EVERYONE", profileDetails: "EVERYONE" });
    });
  });

  describe("username change + 30-day hold", () => {
    let renamer: FixtureUser;
    let probe: FixtureUser;
    let oldHandle: string;
    // Stays inside the zz.e2e. prefix so cleanup still finds the renamed user.
    const newHandle = `${USERNAME_PREFIX}prx${RUN_ID}`;

    beforeAll(async () => {
      renamer = await createUser("prn");
      probe = await createUser("prp");
      oldHandle = renamer.username;
    });

    it("PATCH /api/me/username applies the new handle", async () => {
      const res = await renamer.api.patch("/api/me/username", { json: { username: newHandle } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, username: newHandle, displayUsername: newHandle });

      const me = await renamer.api.get("/api/me");
      expect(me.body.username).toBe(newHandle);
      expect(typeof me.body.usernameChangedAt).toBe("string");
    });

    it("an immediate second change hits the 30-day cooldown (429)", async () => {
      const res = await renamer.api.patch("/api/me/username", { json: { username: `${USERNAME_PREFIX}pry${RUN_ID}` } });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe("You can only change your username once every 30 days");
      expect(typeof res.body.nextAllowedAt).toBe("string");
    });

    it("the old handle is held: another user sees 422 on is-username-available", async () => {
      const res = await probe.api.post("/api/auth/is-username-available", { json: { username: oldHandle } });
      expect(res.status).toBe(422);
      expect(res.body.message).toBe("That username isn't available");
    });

    it("owner exemption: the holder themselves sees their old handle as available", async () => {
      const res = await renamer.api.post("/api/auth/is-username-available", { json: { username: oldHandle } });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ available: true });
    });
  });

  describe("avatar upload (real Cloudinary)", () => {
    let pic: FixtureUser;
    let publicId: string;

    beforeAll(async () => {
      pic = await createUser("prv");
    });

    it("POST with field 'avatar' + a real 256x256 PNG stores an avatar", async () => {
      const form = new FormData();
      form.append("avatar", new File([new Uint8Array(await makePng())], "avatar.png", { type: "image/png" }));
      const res = await pic.api.post("/api/me/avatar", { form });
      expect(res.status).toBe(200);
      // uploadImage stores avatars/<userId>/<12 random bytes as hex>.
      expect(res.body.avatarPublicId).toMatch(new RegExp(`^avatars/${pic.userId}/[0-9a-f]{24}$`));
      expect(res.body.avatarUrl).toContain(res.body.avatarPublicId);
      publicId = res.body.avatarPublicId;

      const me = await pic.api.get("/api/me");
      expect(me.body.avatarPublicId).toBe(publicId);
    });

    it("field named 'file' → 400 'No image provided' (the fake-pass trap)", async () => {
      const form = new FormData();
      form.append("file", new File([new Uint8Array(await makePng())], "avatar.png", { type: "image/png" }));
      const res = await pic.api.post("/api/me/avatar", { form });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "No image provided" });
    });

    it("junk bytes under field 'avatar' → 400 (magic-byte sniff)", async () => {
      const form = new FormData();
      form.append("avatar", new File([new TextEncoder().encode("definitely not an image")], "junk.png", { type: "image/png" }));
      const res = await pic.api.post("/api/me/avatar", { form });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Image must be a JPG, PNG, or WebP" });
    });

    it("DELETE clears the avatar", async () => {
      const res = await pic.api.del("/api/me/avatar");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ avatarPublicId: null, avatarUrl: null });

      const me = await pic.api.get("/api/me");
      expect(me.body.avatarPublicId).toBeNull();
    });
  });

  describe("account deletion scheduling", () => {
    let doomed: FixtureUser;

    beforeAll(async () => {
      doomed = await createUser("prd");
    });

    it("wrong password → 400 and nothing is stamped", async () => {
      const res = await doomed.api.post("/api/me/delete", {
        json: { password: "Wrong.1234", confirmUsername: doomed.username },
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Incorrect password" });

      const [row] = await db
        .select({ deletionScheduledAt: schema.user.deletionScheduledAt })
        .from(schema.user)
        .where(eq(schema.user.id, doomed.userId));
      expect(row.deletionScheduledAt).toBeNull();
    });

    it("correct password + typed username stamps deletionScheduledAt ~30 days out", async () => {
      const res = await doomed.api.post("/api/me/delete", {
        json: { password: PASSWORD, confirmUsername: doomed.username },
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(typeof res.body.deletionScheduledAt).toBe("string");

      const [row] = await db
        .select({ deletionScheduledAt: schema.user.deletionScheduledAt })
        .from(schema.user)
        .where(eq(schema.user.id, doomed.userId));
      expect(row.deletionScheduledAt).not.toBeNull();
      const days = (row.deletionScheduledAt.getTime() - Date.now()) / 86_400_000;
      expect(days).toBeGreaterThan(29);
      expect(days).toBeLessThan(31);
    });

    it("any authenticated request cancels the deletion (cancel-on-login superset)", async () => {
      const me = await doomed.api.get("/api/me");
      expect(me.status).toBe(200);
      expect(me.body.deletionScheduledAt).toBeNull();

      const [row] = await db
        .select({ deletionScheduledAt: schema.user.deletionScheduledAt })
        .from(schema.user)
        .where(eq(schema.user.id, doomed.userId));
      expect(row.deletionScheduledAt).toBeNull();
    });
  });

  describe("email change", () => {
    let mailer: FixtureUser;

    beforeAll(async () => {
      mailer = await createUser("prm");
    });

    it("wrong password → 400", async () => {
      const res = await mailer.api.post("/api/me/email/start", {
        json: { password: "Wrong.1234", newEmail: `nope${RUN_ID}@deeperk-e2e.test` },
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Incorrect password" });
    });

    it("invalid email → 400", async () => {
      const res = await mailer.api.post("/api/me/email/start", {
        json: { password: PASSWORD, newEmail: "not-an-email" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "Invalid request" });
    });

    it.skipIf(!config.testEmail)("start + OTP verify moves the account to the new address", async () => {
      const [local, domain] = (config.testEmail as string).split("@");
      // Plus-addressing keeps the inbox real and per-run unique; cleanup sweeps it.
      const newEmail = `${local}+pr${RUN_ID}@${domain}`.toLowerCase();

      const start = await mailer.api.post("/api/me/email/start", { json: { password: PASSWORD, newEmail } });
      expect(start.status).toBe(200);
      expect(start.body).toEqual({ success: true });

      const otp = await readEmailChangeOtp(mailer.userId);
      const verify = await mailer.api.post("/api/me/email/verify", { json: { otp } });
      expect(verify.status).toBe(200);
      expect(verify.body).toEqual({ success: true, email: newEmail });

      const [row] = await db
        .select({ email: schema.user.email })
        .from(schema.user)
        .where(eq(schema.user.id, mailer.userId));
      expect(row.email).toBe(newEmail);
    });
  });
});
