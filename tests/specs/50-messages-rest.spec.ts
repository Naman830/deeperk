import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createUser, createDirect, type FixtureUser } from "../src/fixtures";
import { connectAs, emitWithAck, closeAllSockets, type SocketSession } from "../src/socket";

/**
 * REST message history: keyset paging (before/after/aroundId), in-conversation
 * search, and how the three deletion shapes surface in history — tombstones
 * (returned with body null), delete-for-me (SQL-filtered, page stays full),
 * and the clear watermark (per-user empty history).
 *
 * 41 seeded TEXT messages in one direct conversation: alice sends indexes
 * 0-24 ("seed 0".."seed 24") and 25 (the literal-percent body), bob sends
 * 26-40 ("seed 25".."seed 39") — each sender stays under the 30/10s socket cap.
 */

const PERCENT_BODY = "totally 100% sure";
const TOTAL = 41;

let alice: FixtureUser;
let bob: FixtureUser;
let carol: FixtureUser;
let aliceSocket: SocketSession;
let bobSocket: SocketSession;
let conversationId: string;
/** A real message id from a DIFFERENT conversation (alice↔carol). */
let foreignMessageId: string;

type Seeded = { id: string; body: string; createdAt: string };
const seeded: Seeded[] = [];

function messagesPath(query = ""): string {
  return `/api/conversations/${conversationId}/messages${query}`;
}

/** The wire cursor format: "<epochMillis>.<messageId>" (formatMessageCursor). */
function cursorOf(message: { createdAt: string; id: string }): string {
  return `${Date.parse(message.createdAt)}.${message.id}`;
}

function tupleAscending(messages: Array<{ createdAt: string; id: string }>): boolean {
  for (let i = 1; i < messages.length; i++) {
    const prevT = Date.parse(messages[i - 1].createdAt);
    const curT = Date.parse(messages[i].createdAt);
    if (prevT > curT) return false;
    if (prevT === curT && messages[i - 1].id >= messages[i].id) return false;
  }
  return true;
}

async function sendText(sender: SocketSession, targetConversationId: string, text: string) {
  const ack = await emitWithAck(sender.socket, "message:send", {
    conversationId: targetConversationId,
    clientMsgId: crypto.randomUUID(),
    type: "TEXT",
    text,
  });
  if (!ack.ok) throw new Error(`seed send failed: ${JSON.stringify(ack)}`);
  return ack.message as { id: string; body: string; createdAt: string };
}

describe("messages REST", () => {
  beforeAll(async () => {
    alice = await createUser("mra");
    bob = await createUser("mrb");
    carol = await createUser("mrc");
    conversationId = await createDirect(alice, bob);
    const otherConversationId = await createDirect(alice, carol);

    aliceSocket = await connectAs(alice.api);
    bobSocket = await connectAs(bob.api);

    for (let n = 0; n < 25; n++) {
      seeded.push(await sendText(aliceSocket, conversationId, `seed ${n}`));
    }
    seeded.push(await sendText(aliceSocket, conversationId, PERCENT_BODY));
    for (let n = 25; n < 40; n++) {
      seeded.push(await sendText(bobSocket, conversationId, `seed ${n}`));
    }
    expect(seeded).toHaveLength(TOTAL);

    foreignMessageId = (await sendText(aliceSocket, otherConversationId, "foreign anchor")).id;
  });

  afterAll(() => closeAllSockets());

  it("default page: newest 30, ascending, hasMore true, nextCursor = oldest returned", async () => {
    const res = await alice.api.get(messagesPath());
    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(30);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    expect(tupleAscending(res.body.messages)).toBe(true);
    // Newest 30 of 41: window is seeds 11..40, render order oldest-first.
    expect(res.body.messages[0].id).toBe(seeded[11].id);
    expect(res.body.messages[29].id).toBe(seeded[40].id);
    expect(res.body.nextCursor).toBe(cursorOf(res.body.messages[0]));
  });

  it("keyset paging: ?before= yields the older 11 with zero overlap and full coverage; garbage cursor is 400", async () => {
    const page1 = await alice.api.get(messagesPath());
    expect(page1.status).toBe(200);

    const page2 = await alice.api.get(messagesPath(`?before=${encodeURIComponent(page1.body.nextCursor)}`));
    expect(page2.status).toBe(200);
    expect(page2.body.messages).toHaveLength(TOTAL - 30);
    expect(page2.body.hasMore).toBe(false);
    expect(page2.body.nextCursor).toBeNull();
    expect(tupleAscending(page2.body.messages)).toBe(true);

    const page1Ids = new Set<string>(page1.body.messages.map((m: { id: string }) => m.id));
    for (const m of page2.body.messages) {
      expect(page1Ids.has(m.id), `page overlap on ${m.id}`).toBe(false);
    }

    // Contiguity: the two pages together are exactly the 41 seeded messages...
    const union = new Set<string>([...page1Ids, ...page2.body.messages.map((m: { id: string }) => m.id)]);
    expect(union.size).toBe(TOTAL);
    for (const s of seeded) expect(union.has(s.id), `missing ${s.body}`).toBe(true);
    // ...and page 2's newest row sorts strictly before page 1's oldest.
    const boundaryOld = page2.body.messages[page2.body.messages.length - 1];
    const boundaryNew = page1.body.messages[0];
    const [t2, t1] = [Date.parse(boundaryOld.createdAt), Date.parse(boundaryNew.createdAt)];
    expect(t2 < t1 || (t2 === t1 && boundaryOld.id < boundaryNew.id)).toBe(true);

    const bad = await alice.api.get(messagesPath("?before=garbage"));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Invalid request");
  });

  it("?after= backfills only newer messages, oldest first, with no paging fields", async () => {
    const anchor = seeded[20];
    const res = await alice.api.get(messagesPath(`?after=${encodeURIComponent(cursorOf(anchor))}`));
    expect(res.status).toBe(200);
    // The route pins these for the after form regardless of result size.
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
    expect(tupleAscending(res.body.messages)).toBe(true);

    const returned = new Set<string>(res.body.messages.map((m: { id: string }) => m.id));
    const newerIds = seeded.slice(21).map((s) => s.id);
    for (const id of newerIds) expect(returned.has(id), `newer message ${id} missing`).toBe(true);
    for (const s of seeded.slice(0, 20)) expect(returned.has(s.id), `older ${s.body} leaked`).toBe(false);
    // The anchor itself may reappear: the cursor is millisecond-truncated while
    // created_at keeps microseconds, so anchor > cursor when the µs part is >0.
    const allowed = new Set<string>([anchor.id, ...newerIds]);
    for (const id of returned) expect(allowed.has(id), `unexpected id ${id}`).toBe(true);
  });

  it("?aroundId= returns the window containing the anchor; a foreign-conversation id is 404", async () => {
    const anchor = seeded[20];
    const res = await alice.api.get(messagesPath(`?aroundId=${anchor.id}`));
    expect(res.status).toBe(200);
    // 15+anchor on the older side, 15 newer — deterministic with 20 each side.
    expect(res.body.messages).toHaveLength(31);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toContain(anchor.id);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toMatch(/^\d+\.[0-9a-f-]{36}$/);
    expect(tupleAscending(res.body.messages)).toBe(true);

    // Real message, wrong conversation: must not confirm it exists elsewhere.
    const foreign = await alice.api.get(messagesPath(`?aroundId=${foreignMessageId}`));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe("Message not found");
  });

  it("search: substring hits newest-first, % is escaped, 1-char query is an empty 200", async () => {
    const res = await alice.api.get(messagesPath(`/search?q=${encodeURIComponent("seed 3")}`));
    expect(res.status).toBe(200);
    // "seed 3" + "seed 30".."seed 39" = 11 hits, newest first (desc, unlike history).
    const expectedDesc = seeded
      .filter((s) => s.body.includes("seed 3"))
      .reverse()
      .map((s) => s.id);
    expect(expectedDesc).toHaveLength(11);
    expect(res.body.messages.map((m: { id: string }) => m.id)).toEqual(expectedDesc);

    // Unescaped, "0%" becomes ILIKE %0%% and matches every body containing "0".
    const pct = await alice.api.get(messagesPath(`/search?q=${encodeURIComponent("0%")}`));
    expect(pct.status).toBe(200);
    expect(pct.body.messages.map((m: { id: string }) => m.id)).toEqual([seeded[25].id]);
    expect(pct.body.messages[0].body).toBe(PERCENT_BODY);

    const short = await alice.api.get(messagesPath("/search?q=s"));
    expect(short.status).toBe(200);
    expect(short.body.messages).toEqual([]);
  });

  it("tombstone: message:delete leaves the row in history with deletedAt set and body null", async () => {
    const target = seeded[24];
    const ack = await emitWithAck(aliceSocket.socket, "message:delete", { messageId: target.id });
    expect(ack.ok).toBe(true);
    expect(ack.messageId).toBe(target.id);
    expect(ack.messageIds).toEqual([target.id]);

    const res = await alice.api.get(messagesPath("?limit=50"));
    expect(res.status).toBe(200);
    // Returned, never filtered: the row count does not shrink.
    expect(res.body.messages).toHaveLength(TOTAL);
    const row = res.body.messages.find((m: { id: string }) => m.id === target.id);
    expect(row).toBeTruthy();
    expect(row.deletedAt).toEqual(expect.any(String));
    expect(row.body).toBeNull();
  });

  it("delete-for-me: bob's history omits it, alice's keeps it, and bob's page stays full", async () => {
    const hidden = seeded[15]; // alice's message, inside the newest-30 window
    const ack = await emitWithAck(bobSocket.socket, "message:delete-for-me", { messageId: hidden.id });
    expect(ack.ok).toBe(true);
    expect(ack.messageId).toBe(hidden.id);
    expect(ack.messageIds).toEqual([hidden.id]);
    // The acting socket never receives message:hidden, so the ack carries this.
    expect(ack.conversationId).toBe(conversationId);

    const bobAll = await bob.api.get(messagesPath("?limit=50"));
    expect(bobAll.status).toBe(200);
    expect(bobAll.body.messages).toHaveLength(TOTAL - 1);
    expect(bobAll.body.messages.some((m: { id: string }) => m.id === hidden.id)).toBe(false);

    // SQL-side filter: the default page is still a FULL 30 with hasMore true —
    // a post-fetch .filter() would return 29 here.
    const bobPage = await bob.api.get(messagesPath());
    expect(bobPage.body.messages).toHaveLength(30);
    expect(bobPage.body.hasMore).toBe(true);
    expect(bobPage.body.messages.some((m: { id: string }) => m.id === hidden.id)).toBe(false);

    const aliceAll = await alice.api.get(messagesPath("?limit=50"));
    expect(aliceAll.body.messages).toHaveLength(TOTAL);
    const stillThere = aliceAll.body.messages.find((m: { id: string }) => m.id === hidden.id);
    expect(stillThere.body).toBe("seed 15");
  });

  it("clear watermark: bob's history empties, alice's is intact", async () => {
    const res = await bob.api.del(`/api/conversations/${conversationId}`, { json: { mode: "clear" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, mode: "clear" });

    const bobAfter = await bob.api.get(messagesPath("?limit=50"));
    expect(bobAfter.status).toBe(200);
    expect(bobAfter.body).toEqual({ messages: [], nextCursor: null, hasMore: false });

    const aliceAfter = await alice.api.get(messagesPath("?limit=50"));
    expect(aliceAfter.body.messages).toHaveLength(TOTAL);
  });
});
