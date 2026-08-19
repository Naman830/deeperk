import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, schema, ops } from "../src/db";
import { createUser, createDirect, newApi, USERNAME_PREFIX, type FixtureUser } from "../src/fixtures";
import { connectAs, emitWithAck, closeAllSockets } from "../src/socket";

/**
 * Search, public-profile privacy gating, and blocking — including the pin the
 * whole block feature hangs on: every blocked interaction answers with the
 * SAME non-committal shape as "no such user", so a block is never a
 * notification to the blocked person.
 */

// The exact BLOCKED constant from server/src/controllers/chat/shared.js — code is
// NOT_FOUND on purpose, but the copy differs from membership's
// "Conversation not found.", which is what proves the block gate fired.
const SOCKET_BLOCKED_ACK = { ok: false, code: "NOT_FOUND", error: "Couldn't send that message." };

const SEARCH_RESULT_KEYS = ["avatarPublicId", "avatarUrl", "displayUsername", "firstName", "lastName", "username"];

let a: FixtureUser; // blocker
let b: FixtureUser; // blocked
let p: FixtureUser; // privacy-toggled profile target
let v: FixtureUser; // independent viewer/searcher (own rate buckets)
let conversationId: string;

function searchPath(q: string): string {
  return `/api/users/search?q=${encodeURIComponent(q)}`;
}

describe("search + block", () => {
  beforeAll(async () => {
    a = await createUser("sba");
    b = await createUser("sbb");
    p = await createUser("sbp");
    v = await createUser("sbv");
    // The DIRECT conversation must exist BEFORE any block, so the socket test
    // below exercises the block gate, not the membership gate.
    conversationId = await createDirect(a, b);
  });

  afterAll(() => closeAllSockets());

  describe("search", () => {
    it("requires a session", async () => {
      const res = await newApi().get(searchPath("zz"));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: "Not authenticated" });
    });

    it("finds a user by username prefix, with the exact result shape", async () => {
      const res = await a.api.get(searchPath(b.username));
      expect(res.status).toBe(200);
      const hit = res.body.results.find((row: { username: string }) => row.username === b.username);
      expect(hit, "fixture b missing from search results").toBeTruthy();
      expect(Object.keys(hit).sort()).toEqual(SEARCH_RESULT_KEYS);
    });

    it("a sub-2-char query is 200 with empty results, not a 400", async () => {
      for (const q of ["a", "%"]) {
        // NOTE: a single "%" is length 1, so it exits via the sub-2 branch —
        // it never reaches the ILIKE at all. The real escape pin is below.
        const res = await v.api.get(searchPath(q));
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ results: [] });
      }
    });

    it("LIKE wildcards are escaped — %% and __ match nothing instead of everything", async () => {
      for (const q of ["%%", "__"]) {
        const res = await v.api.get(searchPath(q));
        expect(res.status).toBe(200);
        // Unescaped, either pattern prefix-matches every user and returns a
        // full page of 10 — the empty array is the whole point.
        expect(res.body).toEqual({ results: [] });
      }
    });

    it("discoverable=NOBODY removes a user from others' search, and EVERYONE restores them", async () => {
      const hide = await p.api.patch("/api/me/privacy", { json: { discoverable: "NOBODY" } });
      expect(hide.status).toBe(200);

      const hidden = await v.api.get(searchPath(p.username));
      expect(hidden.status).toBe(200);
      expect(hidden.body.results).toEqual([]);

      const restore = await p.api.patch("/api/me/privacy", { json: { discoverable: "EVERYONE" } });
      expect(restore.status).toBe(200);

      const found = await v.api.get(searchPath(p.username));
      expect(found.body.results.map((row: { username: string }) => row.username)).toContain(p.username);
    });
  });

  describe("public profile", () => {
    it("defaults expose everything, and isOwner is stripped from the response", async () => {
      const res = await v.api.get(`/api/users/${p.username}`);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe(p.username);
      // Full key set: base identity + both gated groups (no privacy row =
      // EVERYONE), and NOT the isOwner render hint.
      expect(Object.keys(res.body).sort()).toEqual([
        "avatarPublicId",
        "avatarUrl",
        "bio",
        "displayUsername",
        "firstName",
        "isOnline",
        "lastName",
        "lastSeenAt",
        "socialLinks",
        "username",
      ]);
      expect(res.body.socialLinks).toEqual([]);
    });

    it("profileDetails=NOBODY makes bio/socialLinks ABSENT while presence stays", async () => {
      const patch = await p.api.patch("/api/me/privacy", { json: { profileDetails: "NOBODY" } });
      expect(patch.status).toBe(200);

      const res = await v.api.get(`/api/users/${p.username}`);
      expect(res.status).toBe(200);
      // Key-presence, not null: absent and null are different contracts.
      expect("bio" in res.body).toBe(false);
      expect("socialLinks" in res.body).toBe(false);
      expect("isOnline" in res.body).toBe(true);
      expect("lastSeenAt" in res.body).toBe(true);
    });

    it("onlineStatus=NOBODY independently hides isOnline/lastSeenAt", async () => {
      const patch = await p.api.patch("/api/me/privacy", { json: { onlineStatus: "NOBODY" } });
      expect(patch.status).toBe(200);

      const res = await v.api.get(`/api/users/${p.username}`);
      expect(res.status).toBe(200);
      expect("isOnline" in res.body).toBe(false);
      expect("lastSeenAt" in res.body).toBe(false);
      expect(res.body.username).toBe(p.username); // base identity survives both gates

      // Reset both gates and prove the fields come back.
      const reset = await p.api.patch("/api/me/privacy", {
        json: { profileDetails: "EVERYONE", onlineStatus: "EVERYONE" },
      });
      expect(reset.status).toBe(200);
      const after = await v.api.get(`/api/users/${p.username}`);
      expect("bio" in after.body).toBe(true);
      expect("isOnline" in after.body).toBe(true);
    });

    it("missing username is 404; no session is 401", async () => {
      const missing = await v.api.get(`/api/users/${USERNAME_PREFIX}sbmissing`);
      expect(missing.status).toBe(404);
      expect(missing.body).toEqual({ error: "User not found" });

      const anon = await newApi().get(`/api/users/${p.username}`);
      expect(anon.status).toBe(401);
    });
  });

  describe("block", () => {
    it("a blocks b", async () => {
      const res = await a.api.post(`/api/users/${b.username}/block`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, blocked: true });
    });

    it("double-block is idempotent, not a conflict", async () => {
      const res = await a.api.post(`/api/users/${b.username}/block`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, blocked: true });
    });

    it("self-block is 400", async () => {
      const res = await a.api.post(`/api/users/${a.username}/block`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: "You can't block yourself" });
    });

    it("blocking a missing user is 404", async () => {
      const res = await a.api.post(`/api/users/${USERNAME_PREFIX}sbnobody/block`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "User not found" });
    });
  });

  describe("block gates", () => {
    it("blocked DM creation answers the SAME 404 shape as a nonexistent user", async () => {
      const blocked = await b.api.post("/api/conversations/direct", { json: { username: a.username } });
      const missing = await b.api.post("/api/conversations/direct", {
        json: { username: `${USERNAME_PREFIX}sbnobody` },
      });
      expect(blocked.status).toBe(404);
      expect(missing.status).toBe(404);
      // The non-committal pin: byte-identical bodies, so a block is never a notification.
      expect(blocked.body).toEqual(missing.body);
    });

    it("search hides a block in BOTH directions", async () => {
      const bFindsA = await b.api.get(searchPath(a.username));
      expect(bFindsA.status).toBe(200);
      expect(bFindsA.body.results).toEqual([]);

      const aFindsB = await a.api.get(searchPath(b.username));
      expect(aFindsB.status).toBe(200);
      expect(aFindsB.body.results).toEqual([]);
    });

    it("socket send into the pre-existing DM fails with the non-committal BLOCKED ack, for both sides", async () => {
      const bSession = await connectAs(b.api);
      const aSession = await connectAs(a.api);

      const bAck = await emitWithAck(bSession.socket, "message:send", {
        conversationId,
        clientMsgId: crypto.randomUUID(),
        type: "TEXT",
        text: "should never land",
      });
      expect(bAck).toEqual(SOCKET_BLOCKED_ACK);

      // The blocker is gated too — a one-way block is not a block.
      const aAck = await emitWithAck(aSession.socket, "message:send", {
        conversationId,
        clientMsgId: crypto.randomUUID(),
        type: "TEXT",
        text: "blocker side",
      });
      expect(aAck).toEqual(SOCKET_BLOCKED_ACK);
    });

    it("unblock restores sending and reopens the existing DM", async () => {
      const unblock = await a.api.del(`/api/users/${b.username}/block`);
      expect(unblock.status).toBe(200);
      expect(unblock.body).toEqual({ success: true, blocked: false });

      // Unblocking someone not blocked is already the requested state — no 404.
      const again = await a.api.del(`/api/users/${b.username}/block`);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ success: true, blocked: false });

      const bSession = await connectAs(b.api);
      const text = "after the unblock";
      const ack = await emitWithAck(bSession.socket, "message:send", {
        conversationId,
        clientMsgId: crypto.randomUUID(),
        type: "TEXT",
        text,
      });
      expect(ack.ok).toBe(true);
      expect(ack.message.conversationId).toBe(conversationId);
      expect(ack.message.body).toBe(text);

      const reopen = await b.api.post("/api/conversations/direct", { json: { username: a.username } });
      expect(reopen.status).toBe(200);
      expect(reopen.body).toEqual({ conversationId, created: false });
    });
  });

  describe("deactivated accounts", () => {
    it("a deletion-scheduled account 404s for other viewers", async () => {
      // A DIFFERENT viewer on purpose: getSession's cancel-on-login only fires
      // for the owner's own requests, so v's GET can't clear the stamp.
      await db
        .update(schema.user)
        .set({ deletionScheduledAt: new Date() })
        .where(ops.eq(schema.user.id, p.userId));
      try {
        const res = await v.api.get(`/api/users/${p.username}`);
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "User not found" });
      } finally {
        await db
          .update(schema.user)
          .set({ deletionScheduledAt: null })
          .where(ops.eq(schema.user.id, p.userId));
      }

      const restored = await v.api.get(`/api/users/${p.username}`);
      expect(restored.status).toBe(200);
      expect(restored.body.username).toBe(p.username);
    });
  });
});
