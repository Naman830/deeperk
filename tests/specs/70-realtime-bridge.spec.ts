import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { config } from "../src/env";
import { createUser, createGroup, type FixtureUser } from "../src/fixtures";
import {
  connectAs,
  waitFor,
  expectSilence,
  emitWithAck,
  closeAllSockets,
  type SocketSession,
} from "../src/socket";

/**
 * The web -> socket internal bridge (server/src/http/internal.js, called by
 * web/src/lib/chat/notify-socket.ts from eight Next routes). Rooms are joined
 * once at connect; this bridge is the only thing that revises them afterwards.
 * The failure mode it guards against is REST-green/realtime-dead: every route
 * here answers 2xx even when INTERNAL_API_SECRET is wrong, because notifySocket
 * is deliberately best-effort — so only listening sockets can prove the fanout.
 */

type ChatMessagePayload = { conversationId?: string; message?: Record<string, unknown> };

let alice: FixtureUser;
let bob: FixtureUser;
let carol: FixtureUser;
let aliceSock: SocketSession;
let bobSock: SocketSession;
let bobSock2: SocketSession;
let carolSock: SocketSession;
let directId: string;
let groupId: string;
let forwardSourceId: string;

const SOURCE_TEXT = "bridge join pin";

describe("realtime bridge", () => {
  beforeAll(async () => {
    alice = await createUser("rba");
    bob = await createUser("rbb");
    carol = await createUser("rbc");
    // All sockets connect BEFORE any conversation exists, so every room
    // membership asserted below can only have come from the bridge.
    aliceSock = await connectAs(alice.api);
    bobSock = await connectAs(bob.api);
    bobSock2 = await connectAs(bob.api);
    carolSock = await connectAs(carol.api);
  });

  afterAll(() => closeAllSockets());

  it("conversation.created: the other party's live socket is told AND joined to the room", async () => {
    const added = waitFor<{ conversationId: string }>(bobSock.socket, "conversation:added");
    const res = await alice.api.post("/api/conversations/direct", { json: { username: bob.username } });
    expect(res.status).toBe(201);
    // created:true is the premise — the reopen path never calls notifySocket.
    expect(res.body.created).toBe(true);
    directId = res.body.conversationId;
    expect((await added).conversationId).toBe(directId);

    // The join half: bob's socket predates the conversation, so receiving this
    // without reconnecting proves joinUsersToConversation ran.
    const clientMsgId = crypto.randomUUID();
    const incoming = waitFor<ChatMessagePayload>(
      bobSock.socket,
      "message:new",
      (payload) => payload.message?.clientMsgId === clientMsgId,
    );
    const ack = await emitWithAck(aliceSock.socket, "message:send", {
      conversationId: directId,
      clientMsgId,
      type: "TEXT",
      text: SOURCE_TEXT,
    });
    expect(ack.ok).toBe(true);
    forwardSourceId = ack.message.id;
    const broadcast = await incoming;
    expect(broadcast.message?.id).toBe(forwardSourceId);
  });

  it("members.added: the new member gets conversation:added, the room gets conversation:updated", async () => {
    groupId = await createGroup(alice, [bob], "rb bridge group");
    expect(groupId).not.toBe(directId);

    const carolAdded = waitFor<{ conversationId: string }>(
      carolSock.socket,
      "conversation:added",
      (payload) => payload.conversationId === groupId,
    );
    // Alice's socket is only in the group room because the create above bridged
    // a join to her live socket — this doubles as that assertion.
    const aliceUpdated = waitFor<{ conversationId: string }>(
      aliceSock.socket,
      "conversation:updated",
      (payload) => payload.conversationId === groupId,
    );
    const res = await alice.api.post(`/api/conversations/${groupId}/members`, {
      json: { usernames: [carol.username] },
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ success: true, added: 1 });
    await Promise.all([carolAdded, aliceUpdated]);
  });

  it("members.removed: the removed member is told, then the room is revoked", async () => {
    const removed = waitFor<{ conversationId: string; reason: string }>(
      carolSock.socket,
      "conversation:removed",
      (payload) => payload.conversationId === groupId,
    );
    const res = await alice.api.del(`/api/conversations/${groupId}/members/${carol.userId}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect((await removed).reason).toBe("REMOVED");

    // Room revoked: the same group message reaches bob but never carol.
    const clientMsgId = crypto.randomUUID();
    const bobGets = waitFor<ChatMessagePayload>(
      bobSock.socket,
      "message:new",
      (payload) => payload.message?.clientMsgId === clientMsgId,
    );
    const carolSilent = expectSilence(carolSock.socket, "message:new", 800);
    const ack = await emitWithAck(aliceSock.socket, "message:send", {
      conversationId: groupId,
      clientMsgId,
      type: "TEXT",
      text: "after removal",
    });
    expect(ack.ok).toBe(true);
    await bobGets;
    await carolSilent;
  });

  it("conversation.updated: a rename reaches the room carrying the new name", async () => {
    const updated = waitFor<{ conversationId: string; name: string | null; avatarUrl: string | null }>(
      bobSock.socket,
      "conversation:updated",
      (payload) => payload.conversationId === groupId,
    );
    const res = await alice.api.patch(`/api/conversations/${groupId}`, { json: { name: "rb renamed" } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, name: "rb renamed" });
    const payload = await updated;
    expect(payload.name).toBe("rb renamed");
    // The route sends no avatarUrl; the bridge nulls it rather than omitting it.
    expect(payload.avatarUrl).toBeNull();
  });

  it("conversation.read via REST: own tabs get read-sync, the room gets NO read-by", async () => {
    const synced = waitFor<{ conversationId: string; lastReadAt: string | null }>(
      bobSock2.socket,
      "conversation:read-sync",
      (payload) => payload.conversationId === directId,
    );
    // The REST/socket asymmetry: only the socket conversation:read handler
    // emits conversation:read-by to the room; the bridge kind never does.
    const aliceSilent = expectSilence(aliceSock.socket, "conversation:read-by");
    const res = await bob.api.post(`/api/conversations/${directId}/read`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.lastReadAt).toBe("string");
    const payload = await synced;
    expect(payload.lastReadAt).toBe(res.body.lastReadAt);
    await aliceSilent;
  });

  it("message.created: a REST forward lands as message:new on every member socket", async () => {
    // Predicate on the forwarded body — the new row's id isn't known until the
    // response, and waitFor must be registered before acting.
    const matcher = (payload: ChatMessagePayload) =>
      payload.conversationId === groupId && payload.message?.body === SOURCE_TEXT;
    const bobGets = waitFor<ChatMessagePayload>(bobSock.socket, "message:new", matcher);
    // The bridge has no acting socket to exclude, so alice's own socket hears it too.
    const aliceGets = waitFor<ChatMessagePayload>(aliceSock.socket, "message:new", matcher);

    const res = await alice.api.post(`/api/conversations/${groupId}/forward`, {
      json: { messageIds: [forwardSourceId] },
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messages).toHaveLength(1);
    const forwarded = res.body.messages[0];
    // A forward is a new row in the target conversation, not a reference.
    expect(forwarded.id).not.toBe(forwardSourceId);
    expect(forwarded.conversationId).toBe(groupId);

    const [bobPayload, alicePayload] = await Promise.all([bobGets, aliceGets]);
    expect(bobPayload.message).toEqual(forwarded);
    expect(alicePayload.message).toEqual(forwarded);
  });

  it("conversation.self-changed: a mute syncs to own other tabs and nobody else", async () => {
    const selfChanged = waitFor<{ conversationId: string }>(
      bobSock2.socket,
      "conversation:self-changed",
      (payload) => payload.conversationId === directId,
    );
    // Privacy pin: alice must never learn that bob muted their chat.
    const aliceSilent = expectSilence(aliceSock.socket, "conversation:self-changed");
    const res = await bob.api.patch(`/api/conversations/${directId}/state`, { json: { muteMinutes: 60 } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.mutedUntil).toBe("string");
    await selfChanged;
    await aliceSilent;
  });

  it("the bridge endpoint itself: wrong secret 403, unknown kind 400, missing conversationId 400", async () => {
    expect(config.internalApiSecret, "INTERNAL_API_SECRET missing from env — bridge untestable").not.toBe("");
    const url = `${config.socketUrl}/internal/events`;
    const post = (secret: string, body: unknown) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-internal-secret": secret },
        body: JSON.stringify(body),
      });

    const forbidden = await post("definitely-not-the-secret", {
      kind: "conversation.updated",
      conversationId: "x",
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: "Forbidden" });

    // conversationId is validated BEFORE the kind switch, so an unknown kind
    // must carry one to reach the "Unknown event kind" branch.
    const unknownKind = await post(config.internalApiSecret, { kind: "nonsense", conversationId: "x" });
    expect(unknownKind.status).toBe(400);
    expect(await unknownKind.json()).toEqual({ error: "Unknown event kind" });

    const missingConversation = await post(config.internalApiSecret, { kind: "conversation.updated" });
    expect(missingConversation.status).toBe(400);
    expect(await missingConversation.json()).toEqual({ error: "Invalid request" });
  });
});
