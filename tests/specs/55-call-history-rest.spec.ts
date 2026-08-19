import { describe, it, expect, beforeAll } from "vitest";
import { db, schema } from "../src/db";
import { createUser, createDirect, newApi, type FixtureUser } from "../src/fixtures";

/**
 * GET /api/calls — the cursor-paginated history feed behind the /calls list's
 * "Load more". Fixtures are direct DB inserts, not socket-driven calls: the
 * tie-break test needs two rows with an IDENTICAL started_at, which sockets
 * can't produce on demand — and that tie is the exact case the row-value
 * cursor and the (started_at, id) index exist for.
 */

let ca: FixtureUser; // caller, owns the feed under test
let cb: FixtureUser; // the direct counterpart
let cc: FixtureUser; // non-member — must never see these calls
let conversationId: string;

// Insertion order is deliberately not display order.
let newest: string;
let tiedHigh: string; // tied started_at, larger id — sorts before tiedLow
let tiedLow: string;
let oldest: string;

describe("call history REST", () => {
  beforeAll(async () => {
    ca = await createUser("cha");
    cb = await createUser("chb");
    cc = await createUser("chc");
    conversationId = await createDirect(ca, cb);

    // Explicit timestamps (never now()): the tie must be exact.
    const base = Date.now() - 10 * 60 * 1000;
    const tieA = crypto.randomUUID();
    const tieB = crypto.randomUUID();
    tiedHigh = tieA > tieB ? tieA : tieB;
    tiedLow = tieA > tieB ? tieB : tieA;
    newest = crypto.randomUUID();
    oldest = crypto.randomUUID();

    const at = (offsetMin: number) => new Date(base + offsetMin * 60 * 1000);
    await db.insert(schema.call).values([
      { id: newest, conversationId, startedById: ca.userId, kind: "AUDIO", status: "ENDED", startedAt: at(3), endedAt: at(4) },
      { id: tiedHigh, conversationId, startedById: ca.userId, kind: "AUDIO", status: "ENDED", startedAt: at(2), endedAt: at(3) },
      { id: tiedLow, conversationId, startedById: ca.userId, kind: "VIDEO", status: "MISSED", startedAt: at(2), endedAt: at(2) },
      { id: oldest, conversationId, startedById: ca.userId, kind: "AUDIO", status: "ENDED", startedAt: at(1), endedAt: at(2) },
    ]);
  });

  it("requires a session", async () => {
    const res = await newApi().get("/api/calls");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated" });
  });

  it("rejects malformed cursors with 400, never a silent page 1", async () => {
    for (const cursor of ["garbage", "123.", ".abc"]) {
      const res = await ca.api.get(`/api/calls?before=${encodeURIComponent(cursor)}`);
      expect(res.status, `cursor ${cursor}`).toBe(400);
      expect(res.body).toEqual({ error: "Invalid request" });
    }
  });

  it("walks all four calls at limit=1 in (started_at, id) DESC order, ties broken by id", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let lastPage: { hasMore: boolean; nextCursor: string | null } | null = null;
    for (let i = 0; i < 4; i += 1) {
      const query = cursor ? `?limit=1&before=${encodeURIComponent(cursor)}` : "?limit=1";
      const res = await ca.api.get(`/api/calls${query}`);
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(1);
      seen.push(res.body.entries[0].id);
      if (i < 3) {
        expect(res.body.hasMore).toBe(true);
        expect(res.body.nextCursor).toBeTruthy();
      }
      cursor = res.body.nextCursor;
      lastPage = res.body;
    }
    expect(seen).toEqual([newest, tiedHigh, tiedLow, oldest]);
    // The fourth page reports completion — no duplicates, no phantom page.
    expect(lastPage?.hasMore).toBe(false);
    expect(lastPage?.nextCursor).toBeNull();
  });

  it("entry shape matches the documented CallHistoryEntry contract", async () => {
    const res = await ca.api.get("/api/calls?limit=1");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.entries[0]).sort()).toEqual([
      "conversationAvatarPublicId",
      "conversationId",
      "conversationName",
      "conversationType",
      "counterpart",
      "direction",
      "durationSec",
      "endedAt",
      "id",
      "kind",
      "participantCount",
      "startedAt",
      "starter",
      "status",
    ]);
  });

  it("scopes by membership — a non-member's feed contains none of these calls", async () => {
    const res = await cc.api.get("/api/calls");
    expect(res.status).toBe(200);
    const ids = res.body.entries.map((entry: { id: string }) => entry.id);
    for (const callId of [newest, tiedHigh, tiedLow, oldest]) {
      expect(ids).not.toContain(callId);
    }
  });
});
