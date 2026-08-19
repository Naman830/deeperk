import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createUser, createDirect, newApi, type FixtureUser } from "../src/fixtures";
import {
  connectAs,
  expectConnectError,
  waitFor,
  expectSilence,
  emitWithAck,
  closeAllSockets,
  type SocketSession,
} from "../src/socket";

// sharp lives in the root node_modules (hoisted for Next); resolved via
// createRequire like db.ts does for its CJS deps.
const nodeRequire = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sharp: any = nodeRequire("sharp");

/**
 * The socket chat surface, end to end against server/src/controllers/chat/:
 * handshake auth, multi-tab fan-out, send validation, clientMsgId idempotency,
 * media tokens, edit/delete/delete-for-me, read/delivered receipts, typing
 * relay semantics, the onlineStatus=NOBODY receipt gate, and the in-memory
 * 30/10s message rate limit.
 */

type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaWidth: number | null;
  mediaHeight: number | null;
  mediaDurationMs: number | null;
  clientMsgId: string | null;
};

type MessageNew = { conversationId: string; message: ChatMessage };

let alice: FixtureUser;
let bob: FixtureUser;
let conversationId: string;
let aliceTab1: SocketSession;
let aliceTab2: SocketSession;
let bobTab1: SocketSession;
let bobTab2: SocketSession;
let imageMessageId: string;

async function sendText(from: SocketSession, text: string): Promise<ChatMessage> {
  const ack = await emitWithAck(from.socket, "message:send", {
    conversationId,
    clientMsgId: crypto.randomUUID(),
    type: "TEXT",
    text,
  });
  expect(ack.ok).toBe(true);
  return ack.message as ChatMessage;
}

describe("socket chat", () => {
  afterAll(() => closeAllSockets());

  beforeAll(async () => {
    alice = await createUser("sca");
    bob = await createUser("scb");
    // Conversation BEFORE any socket connects: joinInitialRooms only joins
    // rooms that exist at handshake time.
    conversationId = await createDirect(alice, bob);
    aliceTab1 = await connectAs(alice.api);
    aliceTab2 = await connectAs(alice.api);
    bobTab1 = await connectAs(bob.api);
    bobTab2 = await connectAs(bob.api);
  });

  it("a send emitted the instant session:ready arrives is not lost", async () => {
    // Regression pin: handlers used to be registered AFTER the connection
    // handler's awaited presence work, so an emit landing in that window —
    // exactly what a reconnect buffer does — was dropped with no ack ever.
    const earlyUser = await createUser("scer");
    const earlyPartner = await createUser("scep");
    const earlyConversation = await createDirect(earlyUser, earlyPartner);
    const early = await connectAs(earlyUser.api);
    const ack = await emitWithAck(early.socket, "message:send", {
      conversationId: earlyConversation,
      clientMsgId: crypto.randomUUID(),
      type: "TEXT",
      text: "sent inside the registration window",
    });
    expect(ack.ok).toBe(true);
  });

  it("rejects a cookie-less handshake with UNAUTHENTICATED", async () => {
    const error = await expectConnectError(null);
    expect(error.data?.code).toBe("UNAUTHENTICATED");
    expect(error.message).toBe("Not authenticated");
  });

  it("session:ready carries the connecting user's own id and a bootId", () => {
    expect(aliceTab1.userId).toBe(alice.userId);
    expect(bobTab1.userId).toBe(bob.userId);
    expect(aliceTab1.bootId).toBeTypeOf("string");
    expect(aliceTab1.bootId.length).toBeGreaterThan(0);
    // Same server process for every tab.
    expect(aliceTab2.bootId).toBe(aliceTab1.bootId);
  });

  it("message:send fans out to the sender's OTHER tab and to the recipient", async () => {
    const clientMsgId = crypto.randomUUID();
    const tab2Promise = waitFor<MessageNew>(
      aliceTab2.socket,
      "message:new",
      (payload) => payload.message?.clientMsgId === clientMsgId,
    );
    const bobPromise = waitFor<MessageNew>(
      bobTab1.socket,
      "message:new",
      (payload) => payload.message?.clientMsgId === clientMsgId,
    );

    const ack = await emitWithAck(aliceTab1.socket, "message:send", {
      conversationId,
      clientMsgId,
      type: "TEXT",
      text: "multi-tab pin",
    });
    expect(ack.ok).toBe(true);
    expect(ack.clientMsgId).toBe(clientMsgId);
    expect(ack.message.senderId).toBe(alice.userId);

    const [tab2, bobGot] = await Promise.all([tab2Promise, bobPromise]);
    expect(tab2.message.id).toBe(ack.message.id);
    expect(bobGot.message.id).toBe(ack.message.id);
    expect(bobGot.message.body).toBe("multi-tab pin");
    expect(bobGot.conversationId).toBe(conversationId);
  });

  it("message:send rejects bad payloads with flat error acks", async () => {
    const base = { conversationId, clientMsgId: crypto.randomUUID(), type: "TEXT" };

    const empty = await emitWithAck(aliceTab1.socket, "message:send", { ...base, text: "" });
    expect(empty).toMatchObject({ ok: false, code: "INVALID" });

    const tooLong = await emitWithAck(aliceTab1.socket, "message:send", {
      ...base,
      clientMsgId: crypto.randomUUID(),
      text: "x".repeat(4001),
    });
    expect(tooLong).toMatchObject({ ok: false, code: "TOO_LONG" });

    const stranger = await emitWithAck(aliceTab1.socket, "message:send", {
      conversationId: crypto.randomUUID(),
      clientMsgId: crypto.randomUUID(),
      type: "TEXT",
      text: "hello?",
    });
    expect(stranger).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // Authorization-as-validation: SYSTEM is deliberately not sendable.
    const system = await emitWithAck(aliceTab1.socket, "message:send", {
      ...base,
      clientMsgId: crypto.randomUUID(),
      type: "SYSTEM",
      text: "Alice removed Bob",
    });
    expect(system).toMatchObject({ ok: false, code: "INVALID" });

    const longClientId = await emitWithAck(aliceTab1.socket, "message:send", {
      ...base,
      clientMsgId: "a".repeat(65),
      text: "hello",
    });
    expect(longClientId).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("retrying the same clientMsgId acks the ORIGINAL message and broadcasts nothing", async () => {
    const clientMsgId = crypto.randomUUID();
    const payload = { conversationId, clientMsgId, type: "TEXT", text: "retry pin" };

    const firstBroadcast = waitFor<MessageNew>(
      bobTab1.socket,
      "message:new",
      (p) => p.message?.clientMsgId === clientMsgId,
    );
    const first = await emitWithAck(aliceTab1.socket, "message:send", payload);
    expect(first.ok).toBe(true);
    await firstBroadcast;

    // Registered AFTER the first broadcast was consumed, so only a duplicate
    // broadcast could trip it.
    const silence = expectSilence(
      bobTab1.socket,
      "message:new",
      700,
      (p) => (p as MessageNew).message?.clientMsgId === clientMsgId,
    );
    const retry = await emitWithAck(aliceTab1.socket, "message:send", payload);
    expect(retry.ok).toBe(true);
    expect(retry.message.id).toBe(first.message.id);
    expect(retry.clientMsgId).toBe(clientMsgId);
    await silence;
  });

  it("an uploaded media token sends an IMAGE; a tampered token is INVALID", async () => {
    const png: Buffer = await sharp({
      create: { width: 4, height: 3, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();

    const form = new FormData();
    form.append("conversationId", conversationId);
    form.append("file", new Blob([new Uint8Array(png)], { type: "image/png" }), "pin.png");
    const upload = await alice.api.post("/api/upload/chat-media", { form });
    expect(upload.status).toBe(201);
    expect(upload.body.type).toBe("IMAGE");
    expect(upload.body.mediaMime).toBe("image/png");
    expect(upload.body.mediaToken).toBeTypeOf("string");

    const ack = await emitWithAck(aliceTab1.socket, "message:send", {
      conversationId,
      clientMsgId: crypto.randomUUID(),
      type: "IMAGE",
      mediaToken: upload.body.mediaToken,
    });
    expect(ack.ok).toBe(true);
    expect(ack.message.type).toBe("IMAGE");
    expect(ack.message.mediaUrl).toBe(upload.body.mediaUrl);
    expect(ack.message.mediaWidth).toBe(4);
    expect(ack.message.mediaHeight).toBe(3);
    expect(ack.message.body).toBeNull();
    imageMessageId = ack.message.id;

    const token: string = upload.body.mediaToken;
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const bad = await emitWithAck(aliceTab1.socket, "message:send", {
      conversationId,
      clientMsgId: crypto.randomUUID(),
      type: "IMAGE",
      mediaToken: tampered,
    });
    expect(bad).toMatchObject({ ok: false, code: "INVALID" });
  });

  it("a voice upload sends an AUDIO message with a probed duration; a non-media voice flag is 400", async () => {
    // A real 1.2s opus-in-webm recording (tests/fixtures/voice-note.webm,
    // generated by ffmpeg): Cloudinary probes video-resource uploads, so
    // garbage bytes would fail the upload itself, not just the sniff.
    const webm = readFileSync(new URL("../fixtures/voice-note.webm", import.meta.url));

    const form = new FormData();
    form.append("conversationId", conversationId);
    form.append("voice", "1");
    form.append("file", new Blob([new Uint8Array(webm)], { type: "audio/webm" }), "Voice message");
    const upload = await alice.api.post("/api/upload/chat-media", { form });
    expect(upload.status).toBe(201);
    expect(upload.body.type).toBe("AUDIO");
    expect(upload.body.mediaMime).toBe("audio/webm");
    // Cloudinary's probe of the 1.2s fixture — loose bounds, codec padding varies.
    expect(upload.body.mediaDurationMs).toBeGreaterThan(500);
    expect(upload.body.mediaDurationMs).toBeLessThan(3000);

    const bobSees = waitFor<MessageNew>(
      bobTab1.socket,
      "message:new",
      (p) => p.message?.type === "AUDIO",
    );
    const ack = await emitWithAck(aliceTab1.socket, "message:send", {
      conversationId,
      clientMsgId: crypto.randomUUID(),
      type: "AUDIO",
      mediaToken: upload.body.mediaToken,
    });
    expect(ack.ok).toBe(true);
    expect(ack.message.type).toBe("AUDIO");
    expect(ack.message.mediaUrl).toBe(upload.body.mediaUrl);
    expect(ack.message.mediaDurationMs).toBe(upload.body.mediaDurationMs);
    expect(ack.message.body).toBeNull();
    await bobSees;

    // The voice flag only ever narrows an allowlisted A/V container — an image
    // marked voice is refused outright.
    const png: Buffer = await sharp({
      create: { width: 2, height: 2, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .png()
      .toBuffer();
    const badForm = new FormData();
    badForm.append("conversationId", conversationId);
    badForm.append("voice", "1");
    badForm.append("file", new Blob([new Uint8Array(png)], { type: "audio/webm" }), "fake-voice");
    const bad = await alice.api.post("/api/upload/chat-media", { form: badForm });
    expect(bad.status).toBe(400);
  });

  it("message:edit updates own TEXT and answers NOT_FOUND for everything else", async () => {
    const mine = await sendText(aliceTab1, "edit me");

    const editedPromise = waitFor<{ conversationId: string; messageId: string; body: string; editedAt: string }>(
      bobTab1.socket,
      "message:edited",
      (p) => p.messageId === mine.id,
    );
    const ack = await emitWithAck(aliceTab1.socket, "message:edit", {
      messageId: mine.id,
      text: "edited body",
    });
    expect(ack).toMatchObject({
      ok: true,
      messageId: mine.id,
      conversationId,
      body: "edited body",
    });
    expect(ack.editedAt).toBeTypeOf("string");
    const edited = await editedPromise;
    expect(edited.body).toBe("edited body");
    expect(edited.editedAt).toBe(ack.editedAt);

    // Someone else's message: same answer as "no such message".
    const bobs = await sendText(bobTab1, "bob's message");
    const notMine = await emitWithAck(aliceTab1.socket, "message:edit", {
      messageId: bobs.id,
      text: "hijacked",
    });
    expect(notMine).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // TEXT-only: an IMAGE is unfixable by design.
    const image = await emitWithAck(aliceTab1.socket, "message:edit", {
      messageId: imageMessageId,
      text: "caption?",
    });
    expect(image).toMatchObject({ ok: false, code: "NOT_FOUND" });

    // A tombstone can't be edited back to life.
    const doomed = await sendText(aliceTab1, "soon deleted");
    const del = await emitWithAck(aliceTab1.socket, "message:delete", { messageId: doomed.id });
    expect(del.ok).toBe(true);
    const tombstone = await emitWithAck(aliceTab1.socket, "message:edit", {
      messageId: doomed.id,
      text: "resurrect",
    });
    expect(tombstone).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("message:delete accepts both single and bulk shapes and broadcasts per id", async () => {
    const m1 = await sendText(aliceTab1, "delete one");
    const m2 = await sendText(aliceTab1, "delete two");
    const m3 = await sendText(aliceTab1, "delete three");

    const singlePromise = waitFor<{ conversationId: string; messageId: string; deletedAt: string }>(
      bobTab1.socket,
      "message:deleted",
      (p) => p.messageId === m1.id,
    );
    const single = await emitWithAck(aliceTab1.socket, "message:delete", { messageId: m1.id });
    expect(single).toMatchObject({ ok: true, messageId: m1.id, messageIds: [m1.id] });
    const singleEvent = await singlePromise;
    expect(singleEvent.conversationId).toBe(conversationId);
    expect(singleEvent.deletedAt).toBeTypeOf("string");

    const bulkPromises = [m2, m3].map((m) =>
      waitFor<{ messageId: string }>(bobTab1.socket, "message:deleted", (p) => p.messageId === m.id),
    );
    const bulk = await emitWithAck(aliceTab1.socket, "message:delete", { messageIds: [m2.id, m3.id] });
    expect(bulk.ok).toBe(true);
    expect([...bulk.messageIds].sort()).toEqual([m2.id, m3.id].sort());
    expect(bulk.messageIds).toContain(bulk.messageId);
    await Promise.all(bulkPromises);

    const bobs = await sendText(bobTab1, "not alice's to delete");
    const theirs = await emitWithAck(aliceTab1.socket, "message:delete", { messageId: bobs.id });
    expect(theirs).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("delete-for-me notifies only the actor's other tabs, never other members", async () => {
    const target = await sendText(aliceTab1, "hide me");

    const hiddenPromise = waitFor<{ conversationId: string; messageId: string }>(
      bobTab2.socket,
      "message:hidden",
      (p) => p.messageId === target.id,
    );
    // The message's own sender must never learn it was hidden.
    const aliceSilence = expectSilence(
      aliceTab1.socket,
      "message:hidden",
      700,
      (p) => (p as { messageId?: string }).messageId === target.id,
    );

    const ack = await emitWithAck(bobTab1.socket, "message:delete-for-me", { messageId: target.id });
    expect(ack).toMatchObject({
      ok: true,
      messageId: target.id,
      messageIds: [target.id],
      conversationId,
    });

    const hidden = await hiddenPromise;
    expect(hidden.conversationId).toBe(conversationId);
    await aliceSilence;
  });

  it("conversation:read acks a watermark, tells the room, and syncs own tabs", async () => {
    const readByPromise = waitFor<{ conversationId: string; userId: string; lastReadAt: string }>(
      aliceTab1.socket,
      "conversation:read-by",
      (p) => p.userId === bob.userId,
    );
    const syncPromise = waitFor<{ conversationId: string; lastReadAt: string }>(
      bobTab2.socket,
      "conversation:read-sync",
      (p) => p.conversationId === conversationId,
    );

    const ack = await emitWithAck(bobTab1.socket, "conversation:read", { conversationId });
    expect(ack).toMatchObject({ ok: true, conversationId });
    expect(ack.lastReadAt).toBeTypeOf("string");

    const [readBy, sync] = await Promise.all([readByPromise, syncPromise]);
    expect(readBy.conversationId).toBe(conversationId);
    expect(readBy.lastReadAt).toBe(ack.lastReadAt);
    expect(sync.lastReadAt).toBe(ack.lastReadAt);
  });

  it("conversation:delivered has no ack; the other member observes it", async () => {
    const deliveredPromise = waitFor<{ conversationId: string; userId: string; lastDeliveredAt: string | null }>(
      aliceTab1.socket,
      "conversation:delivered",
      (p) => p.userId === bob.userId,
    );
    bobTab1.socket.emit("conversation:delivered", { conversationId });
    const delivered = await deliveredPromise;
    expect(delivered.conversationId).toBe(conversationId);
    expect(delivered.lastDeliveredAt).toBeTypeOf("string");
  });

  it("typing:start reaches the peer AND the sender's other tab, not the emitting socket", async () => {
    const alicePromise = waitFor<{ conversationId: string; userId: string; username: string }>(
      aliceTab1.socket,
      "typing:start",
      (p) => p.userId === bob.userId,
    );
    // Real behavior pin: socket.to(room) excludes only the EMITTING socket, so
    // the sender's other tab DOES receive its own user's typing event.
    const otherTabPromise = waitFor<{ userId: string; username: string }>(
      bobTab2.socket,
      "typing:start",
      (p) => p.userId === bob.userId,
    );
    const emitterSilence = expectSilence(
      bobTab1.socket,
      "typing:start",
      700,
      (p) => (p as { userId?: string }).userId === bob.userId,
    );

    bobTab1.socket.emit("typing:start", { conversationId });
    const [toAlice, toOtherTab] = await Promise.all([alicePromise, otherTabPromise]);
    expect(toAlice.username).toBe(bob.username);
    expect(toAlice.conversationId).toBe(conversationId);
    expect(toOtherTab.username).toBe(bob.username);
    await emitterSilence;
  });

  it("onlineStatus NOBODY suppresses presence:online and read receipts, but the read still acks", async () => {
    const pv = await createUser("scpv");
    const watcher = await createUser("scpw");
    const pvConversationId = await createDirect(pv, watcher);

    // BEFORE pv's first socket event — the server memoizes privacy for 60s.
    const patched = await pv.api.patch("/api/me/privacy", { json: { onlineStatus: "NOBODY" } });
    expect(patched.status).toBe(200);
    expect(patched.body.success).toBe(true);

    const watcherSession = await connectAs(watcher.api);
    // Registered before pv connects: window covers handshake + the emit lag.
    const onlineSilence = expectSilence(
      watcherSession.socket,
      "presence:online",
      1500,
      (p) => (p as { userId?: string }).userId === pv.userId,
    );
    const pvSession = await connectAs(pv.api);
    expect(pvSession.userId).toBe(pv.userId);
    await onlineSilence;

    const readBySilence = expectSilence(
      watcherSession.socket,
      "conversation:read-by",
      800,
      (p) => (p as { userId?: string }).userId === pv.userId,
    );
    const ack = await emitWithAck(pvSession.socket, "conversation:read", {
      conversationId: pvConversationId,
    });
    expect(ack).toMatchObject({ ok: true, conversationId: pvConversationId });
    expect(ack.lastReadAt).toBeTypeOf("string");
    await readBySilence;
  });

  it("the 31st message in a 10s window is RATE_LIMITED", async () => {
    const rl = await createUser("scrl");
    const partner = await createUser("scrlb");
    const rlConversationId = await createDirect(rl, partner);
    const rlSession = await connectAs(rl.api);

    // Emitted back-to-back so all 31 allow() calls land inside one window; the
    // limiter runs before any DB work, so ack order can't reorder the check.
    const ackPromises: Promise<{ ok: boolean; code?: string }>[] = [];
    for (let i = 0; i < 31; i++) {
      ackPromises.push(
        emitWithAck(
          rlSession.socket,
          "message:send",
          { conversationId: rlConversationId, clientMsgId: crypto.randomUUID(), type: "TEXT", text: `burst ${i}` },
          15_000,
        ),
      );
    }
    const acks = await Promise.all(ackPromises);

    expect(acks[0].ok).toBe(true);
    const limited = acks.filter((ack) => !ack.ok && ack.code === "RATE_LIMITED");
    expect(limited.length).toBeGreaterThanOrEqual(1);
    if (acks.slice(0, 30).every((ack) => ack.ok)) {
      expect(acks[30]).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    }
  });
});
