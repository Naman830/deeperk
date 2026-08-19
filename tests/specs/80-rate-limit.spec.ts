import { describe, it, expect, beforeAll } from "vitest";
import { db, schema } from "../src/db";
import { seedRateLimit, eq } from "../src/cleanup";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";

/**
 * HTTP rate limiting, proven deterministically against ONE representative
 * DB-backed bucket — chat-history (GET /api/conversations/:id/messages,
 * `chat-history:<userId>`, 60 requests / 60s window). No hammering: the
 * bucket is seeded to its cap via seedRateLimit, then reopened by rewinding
 * windowStart, exercising both branches of checkRateLimit's CASE upsert.
 *
 * Inventory of the other checkRateLimit buckets (key template, window, max),
 * read from every call site on 2026-08-18 — for future specs to extend:
 *
 *   login:<email>:<ip>            900s   10    lib/auth/server.ts
 *   forgot-password:<email>       3600s   3    lib/auth/server.ts
 *   signup-otp-email:<email>      3600s   5    api/signup/send-otp
 *   signup-otp-ip:<ip>            3600s  20    api/signup/send-otp
 *   signup-verify-email:<email>   3600s  10    api/signup/verify-otp
 *   signup-verify-ip:<ip>         3600s  30    api/signup/verify-otp
 *   signup-check-email-ip:<ip>    3600s  30    api/signup/check-email
 *   signup-create:<ip>            3600s   3    api/signup/complete
 *   profile-update:<userId>       3600s  30    api/me
 *   privacy-update:<userId>       3600s  30    api/me/privacy
 *   avatar-upload:<userId>        3600s  10    api/me/avatar (POST + DELETE)
 *   confirm-password:<userId>      900s   5    api/me/email/start + api/me/delete (shared gate)
 *   email-change-start:<userId>   3600s   3    api/me/email/start
 *   email-change-verify:<userId>  3600s  10    api/me/email/verify
 *   delete-account:<userId>      86400s   3    api/me/delete
 *   user-search:<userId>            60s  20    api/users/search
 *   block:<userId>                3600s  60    api/users/[username]/block (POST + DELETE)
 *   conversation-list:<userId>      60s 120    api/conversations
 *   dm-start:<userId>             3600s  20    api/conversations/direct
 *   group-create:<userId>        86400s   5    api/conversations/group
 *   group-update:<userId>         3600s  30    api/conversations/[id] PATCH
 *   conversation-clear:<userId>   3600s  30    api/conversations/[id] (clear)
 *   group-members:<actorId>       3600s  20    api/conversations/[id]/members[/userId]
 *   group-add-target:<targetId>  86400s  10    api/conversations/[id]/members (per added user)
 *   conversation-state:<userId>   3600s 120    api/conversations/[id]/state
 *   chat-history:<userId>           60s  60    api/conversations/[id]/messages  ← tested here
 *   chat-search:<userId>            60s  60    api/conversations/[id]/messages/search
 *   chat-media-list:<userId>        60s  60    api/conversations/[id]/media
 *   forward:<userId>                60s  30    api/conversations/[id]/forward
 *   chat-media:<userId>             60s  10    api/upload/chat-media     ← tested here
 *   chat-media-daily:<userId>    86400s 100    api/upload/chat-media     ← tested here
 */

// Pinned from api/conversations/[id]/messages/route.ts's HISTORY_LIMIT.
const HISTORY = { windowSeconds: 60, max: 60 };
const LIMIT_BODY = { error: "Too many requests. Please try again later." };

let user: FixtureUser;
let other: FixtureUser;
let conversationId: string;
let bucketKey: string;

describe("http rate limit (chat-history bucket)", () => {
  beforeAll(async () => {
    // Dedicated fixture user so no other spec's traffic shares this bucket.
    user = await createUser("rta");
    other = await createUser("rtb");
    conversationId = await createDirect(user, other);
    bucketKey = `chat-history:${user.userId}`;
  });

  it("baseline: history GET answers 200 for a member", async () => {
    const res = await user.api.get(`/api/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
    expect(res.body.hasMore).toBe(false);
  });

  it("a bucket seeded at its cap makes the very next GET a 429", async () => {
    await seedRateLimit(bucketKey, HISTORY.max);
    const res = await user.api.get(`/api/conversations/${conversationId}/messages`);
    expect(res.status).toBe(429);
    expect(res.body).toEqual(LIMIT_BODY);
  });

  it("the limit is per-user: the other member is unaffected", async () => {
    const res = await other.api.get(`/api/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);
  });

  it("rewinding windowStart past the window reopens the bucket", async () => {
    // seedRateLimit stamps now(), so age the row directly to trip the CASE reset.
    await db
      .update(schema.rateLimitHit)
      .set({ windowStart: new Date(Date.now() - (HISTORY.windowSeconds + 5) * 1000) })
      .where(eq(schema.rateLimitHit.bucketKey, bucketKey));

    const res = await user.api.get(`/api/conversations/${conversationId}/messages`);
    expect(res.status).toBe(200);

    // The reset path rewrites count to 1, not cap+2 — pin it in the row itself.
    const rows = await db
      .select({ count: schema.rateLimitHit.count })
      .from(schema.rateLimitHit)
      .where(eq(schema.rateLimitHit.bucketKey, bucketKey));
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(1);
  });

  it("the two chat-media buckets 429 before any parsing or Cloudinary spend", async () => {
    // Both limits gate formData() itself, so a header-only probe suffices —
    // the "file" here is 8 junk bytes that never reach the sniff.
    const probe = () => {
      const form = new FormData();
      form.append("conversationId", conversationId);
      form.append("file", new Blob([new Uint8Array(8)], { type: "image/png" }), "junk.png");
      return user.api.post("/api/upload/chat-media", { form });
    };

    await seedRateLimit(`chat-media:${user.userId}`, 10);
    const perMinute = await probe();
    expect(perMinute.status).toBe(429);
    expect(perMinute.body).toEqual({ error: "Too many uploads. Please try again later." });

    // Reopen the per-minute bucket so only the daily one can trip next.
    await db
      .update(schema.rateLimitHit)
      .set({ windowStart: new Date(Date.now() - 65 * 1000) })
      .where(eq(schema.rateLimitHit.bucketKey, `chat-media:${user.userId}`));
    await seedRateLimit(`chat-media-daily:${user.userId}`, 100);
    const daily = await probe();
    expect(daily.status).toBe(429);
    expect(daily.body).toEqual({ error: "Daily upload limit reached." });
  });
});
