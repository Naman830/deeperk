import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db, schema, ops } from "../src/db";
import { createUser, createDirect, createGroup, type FixtureUser } from "../src/fixtures";
import {
  connectAs,
  waitFor,
  expectSilence,
  emitWithAck,
  closeAllSockets,
  type SocketSession,
} from "../src/socket";

/**
 * The call signaling surface, end to end against the locked wire contract
 * (server/src/controllers/call/): invite/ring fan-out, accept/join, rtc:signal
 * relay, mute-state, cancel/reject/leave, the CALL history bubble, disconnect
 * behavior, the busy matrix, group mesh limits, authz masking, the block gate
 * and the 15/hr invite limiter. Media itself needs a browser — out of scope.
 */

// The server's timer env (same server/.env this harness loads). The two
// timer tests only run when the window fits inside a test — restart the
// server after lowering these or the gate and the server disagree.
const RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS ?? 30_000);
const GRACE_MS = Number(process.env.CALL_DISCONNECT_GRACE_MS ?? 15_000);

/** Same 18 sorted fields 00-contracts pins for serialize()/toChatMessage. */
const MESSAGE_FIELDS = [
  "body",
  "callId",
  "clientMsgId",
  "conversationId",
  "createdAt",
  "deletedAt",
  "editedAt",
  "id",
  "mediaDurationMs",
  "mediaHeight",
  "mediaMime",
  "mediaName",
  "mediaSize",
  "mediaUrl",
  "mediaWidth",
  "replyToId",
  "senderId",
  "type",
];

/** Sorted key set of the contract's CallUser. */
const CALL_USER_FIELDS = ["avatarPublicId", "firstName", "id", "lastName", "username"];

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

type CallUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  avatarPublicId: string | null;
};
type RingPayload = {
  callId: string;
  conversationId: string;
  conversationType: string;
  conversationName: string | null;
  kind: string;
  caller: CallUser;
  startedAt: string;
  ringTimeoutMs: number;
};
type StartedPayload = { callId: string; conversationId: string; kind: string; startedById: string; startedAt: string };
type JoinedPayload = { callId: string; conversationId: string; user: CallUser; joinedUserIds: string[] };
type LeftPayload = { callId: string; conversationId: string; userId: string; joinedUserIds: string[] };
type EndedPayload = { callId: string; conversationId: string; status: string; endedAt: string };
type SignalPayload = { callId: string; from: string; data: unknown };
type MutePayload = { callId: string; userId: string; micMuted: boolean; cameraOff: boolean };
type MessageNew = { conversationId: string; message: Record<string, unknown> };

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe("socket calls", () => {
  afterAll(() => closeAllSockets());

  describe("1:1 lifecycle", () => {
    let cal: FixtureUser; // caller in the happy + reject calls
    let cee: FixtureUser; // callee, two tabs
    let conversationId: string;
    let calTab: SocketSession;
    let ceeTab1: SocketSession;
    let ceeTab2: SocketSession;
    let callId: string;

    beforeAll(async () => {
      cal = await createUser("clca");
      cee = await createUser("clcb");
      // Conversation BEFORE any socket connects (joinInitialRooms rule).
      conversationId = await createDirect(cal, cee);
      calTab = await connectAs(cal.api);
      ceeTab1 = await connectAs(cee.api);
      ceeTab2 = await connectAs(cee.api);
    });

    it("invite acks the full contract and rings every callee tab", async () => {
      const ring1P = waitFor<RingPayload>(ceeTab1.socket, "call:ring", (p) => p.conversationId === conversationId);
      const ring2P = waitFor<RingPayload>(ceeTab2.socket, "call:ring", (p) => p.conversationId === conversationId);
      const startedP = waitFor<StartedPayload>(
        ceeTab1.socket,
        "call:started",
        (p) => p.conversationId === conversationId,
      );

      const ack = await emitWithAck(calTab.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(ack.ok).toBe(true);
      expect(ack.callId).toMatch(UUID_RE);
      expect(ack.conversationId).toBe(conversationId);
      expect(ack.kind).toBe("AUDIO");
      expect(ack.ringingUserIds).toEqual([cee.userId]);
      expect(Array.isArray(ack.iceServers)).toBe(true);
      expect(ack.iceServers.length).toBeGreaterThan(0);
      expect(ack.iceServers[0].urls).toBeTruthy();
      expect(ack.ringTimeoutMs).toBeTypeOf("number");
      expect(ack.ringTimeoutMs).toBeGreaterThan(0);
      callId = ack.callId;

      const [ring1, ring2, started] = await Promise.all([ring1P, ring2P, startedP]);
      expect(ring1.callId).toBe(callId);
      expect(ring1.kind).toBe("AUDIO");
      expect(ring1.conversationType).toBe("DIRECT");
      expect("conversationName" in ring1).toBe(true);
      expect(ring1.caller).toMatchObject({ id: cal.userId, username: cal.username });
      expect(Object.keys(ring1.caller).sort()).toEqual(CALL_USER_FIELDS);
      expect(ring1.startedAt).toBeTypeOf("string");
      expect(ring1.ringTimeoutMs).toBe(ack.ringTimeoutMs);
      expect(ring2.callId).toBe(callId);
      expect(started).toMatchObject({ callId, conversationId, kind: "AUDIO", startedById: cal.userId });
      expect(started.startedAt).toBeTypeOf("string");
    });

    it("accept acks the incumbents and broadcasts participant-joined to caller + own other tab", async () => {
      const joinedCalP = waitFor<JoinedPayload>(calTab.socket, "call:participant-joined", (p) => p.callId === callId);
      const joinedTab2P = waitFor<JoinedPayload>(
        ceeTab2.socket,
        "call:participant-joined",
        (p) => p.callId === callId,
      );

      const ack = await emitWithAck(ceeTab1.socket, "call:accept", { callId });
      expect(ack.ok).toBe(true);
      expect(ack.callId).toBe(callId);
      expect(ack.conversationId).toBe(conversationId);
      expect(ack.kind).toBe("AUDIO");
      // Already-joined participants excluding self: just the caller.
      expect(ack.participants.map((u: CallUser) => u.id)).toEqual([cal.userId]);
      expect(Object.keys(ack.participants[0]).sort()).toEqual(CALL_USER_FIELDS);
      expect(ack.iceServers.length).toBeGreaterThan(0);

      const [joinedCal, joinedTab2] = await Promise.all([joinedCalP, joinedTab2P]);
      expect(joinedCal.user.id).toBe(cee.userId);
      expect(Object.keys(joinedCal.user).sort()).toEqual(CALL_USER_FIELDS);
      expect(sorted(joinedCal.joinedUserIds)).toEqual(sorted([cal.userId, cee.userId]));
      expect(joinedTab2.user.id).toBe(cee.userId);
    });

    it("rtc:signal relays the payload verbatim, both directions, to every target tab", async () => {
      const offer = { type: "offer", sdp: "v=0 fake-sdp-offer", nested: { seq: 1 } };
      const onCee1 = waitFor<SignalPayload>(ceeTab1.socket, "rtc:signal", (p) => p.callId === callId);
      const onCee2 = waitFor<SignalPayload>(ceeTab2.socket, "rtc:signal", (p) => p.callId === callId);
      calTab.socket.emit("rtc:signal", { callId, to: cee.userId, data: offer });
      const [got1, got2] = await Promise.all([onCee1, onCee2]);
      expect(got1).toEqual({ callId, from: cal.userId, data: offer });
      expect(got2).toEqual(got1);

      const answer = { type: "answer", sdp: "v=0 fake-sdp-answer" };
      const onCal = waitFor<SignalPayload>(
        calTab.socket,
        "rtc:signal",
        (p) => p.callId === callId && (p.data as { type?: string })?.type === "answer",
      );
      ceeTab1.socket.emit("rtc:signal", { callId, to: cal.userId, data: answer });
      expect(await onCal).toEqual({ callId, from: cee.userId, data: answer });
    });

    it("call:mute-state reaches the other participant, never the sender's own tabs", async () => {
      const onCal = waitFor<MutePayload>(calTab.socket, "call:mute-state", (p) => p.callId === callId);
      const selfSilence = expectSilence(
        ceeTab2.socket,
        "call:mute-state",
        700,
        (p) => (p as { callId?: string }).callId === callId,
      );
      ceeTab1.socket.emit("call:mute-state", { callId, micMuted: true, cameraOff: false });
      const mute = await onCal;
      expect(mute).toEqual({ callId, userId: cee.userId, micMuted: true, cameraOff: false });
      await selfSilence;
    });

    it("leave ends the DIRECT call: ENDED event, 18-field CALL bubble, DB rows", async () => {
      const endedP = waitFor<EndedPayload>(calTab.socket, "call:ended", (p) => p.callId === callId);
      const bubbleP = waitFor<MessageNew>(calTab.socket, "message:new", (p) => p.message?.callId === callId);

      const ack = await emitWithAck(ceeTab1.socket, "call:leave", { callId });
      expect(ack).toMatchObject({ ok: true, callId, ended: true });

      const ended = await endedP;
      expect(ended.conversationId).toBe(conversationId);
      expect(ended.status).toBe("ENDED");
      expect(ended.endedAt).toBeTypeOf("string");

      const bubble = (await bubbleP).message;
      expect(Object.keys(bubble).sort()).toEqual(MESSAGE_FIELDS);
      expect(bubble.type).toBe("CALL");
      expect(bubble.callId).toBe(callId);
      expect(bubble.senderId).toBe(cal.userId);
      expect(bubble.clientMsgId).toBeNull();
      const body = JSON.parse(String(bubble.body));
      expect(body.status).toBe("ENDED");
      expect(body.kind).toBe("AUDIO");
      expect(body.durationSec).toBeTypeOf("number");
      expect(body.durationSec).toBeGreaterThanOrEqual(0);

      const [callRow] = await db.select().from(schema.call).where(ops.eq(schema.call.id, callId));
      expect(callRow.status).toBe("ENDED");
      expect(callRow.kind).toBe("AUDIO");
      expect(callRow.startedById).toBe(cal.userId);
      expect(callRow.endedAt).not.toBeNull();
      const participants = await db
        .select()
        .from(schema.callParticipant)
        .where(ops.eq(schema.callParticipant.callId, callId));
      expect(sorted(participants.map((row: { userId: string }) => row.userId))).toEqual(
        sorted([cal.userId, cee.userId]),
      );
      for (const row of participants) {
        expect(row.joinedAt).not.toBeNull();
        expect(row.leftAt).not.toBeNull();
      }
    });

    it("reject ends REJECTED: no durationSec, callee participant never joinedAt", async () => {
      const ringP = waitFor<RingPayload>(ceeTab1.socket, "call:ring", (p) => p.conversationId === conversationId);
      const inv = await emitWithAck(calTab.socket, "call:invite", { conversationId, kind: "VIDEO" });
      expect(inv.ok).toBe(true);
      expect((await ringP).kind).toBe("VIDEO");

      // "Rung, un-joined only": the caller can't reject their own call.
      const byCaller = await emitWithAck(calTab.socket, "call:reject", { callId: inv.callId });
      expect(byCaller).toMatchObject({ ok: false, code: "NOT_FOUND" });

      const endedP = waitFor<EndedPayload>(calTab.socket, "call:ended", (p) => p.callId === inv.callId);
      const bubbleP = waitFor<MessageNew>(calTab.socket, "message:new", (p) => p.message?.callId === inv.callId);
      const rej = await emitWithAck(ceeTab1.socket, "call:reject", { callId: inv.callId });
      expect(rej).toMatchObject({ ok: true, callId: inv.callId });

      expect((await endedP).status).toBe("REJECTED");
      const bubble = (await bubbleP).message;
      expect(bubble.senderId).toBe(cal.userId);
      const body = JSON.parse(String(bubble.body));
      expect(body.status).toBe("REJECTED");
      expect(body.kind).toBe("VIDEO");
      expect(body.durationSec ?? null).toBeNull();

      const [callRow] = await db.select().from(schema.call).where(ops.eq(schema.call.id, inv.callId));
      expect(callRow.status).toBe("REJECTED");
      const [ceeRow] = await db
        .select()
        .from(schema.callParticipant)
        .where(ops.and(ops.eq(schema.callParticipant.callId, inv.callId), ops.eq(schema.callParticipant.userId, cee.userId)));
      expect(ceeRow.joinedAt).toBeNull();
    });

    it("cancel ends MISSED and dismisses the callee's ring", async () => {
      // Roles swapped: reject started cal's ~20s (caller, conversation) cooldown.
      const ringP = waitFor<RingPayload>(calTab.socket, "call:ring", (p) => p.conversationId === conversationId);
      const inv = await emitWithAck(ceeTab1.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      expect(inv.ringingUserIds).toEqual([cal.userId]);
      await ringP;

      // "Caller, RINGING only": the rung side can't cancel.
      const byCallee = await emitWithAck(calTab.socket, "call:cancel", { callId: inv.callId });
      expect(byCallee).toMatchObject({ ok: false, code: "NOT_FOUND" });

      const endedP = waitFor<EndedPayload>(calTab.socket, "call:ended", (p) => p.callId === inv.callId);
      const bubbleP = waitFor<MessageNew>(ceeTab1.socket, "message:new", (p) => p.message?.callId === inv.callId);
      const cancel = await emitWithAck(ceeTab1.socket, "call:cancel", { callId: inv.callId });
      expect(cancel).toMatchObject({ ok: true, callId: inv.callId });

      expect((await endedP).status).toBe("MISSED");
      const body = JSON.parse(String((await bubbleP).message.body));
      expect(body.status).toBe("MISSED");
      expect(body.durationSec ?? null).toBeNull();

      // Terminal states take no transitions: CALL_ENDED while the finalize is
      // in flight, NOT_FOUND once the record is gone — both mean "over".
      const late = await emitWithAck(calTab.socket, "call:accept", { callId: inv.callId });
      expect(late.ok).toBe(false);
      expect(["NOT_FOUND", "CALL_ENDED"]).toContain(late.code);
    });
  });

  describe("callee disconnect mid-ring", () => {
    it("a ringing DIRECT callee's last socket dying ends the call MISSED fast", async () => {
      // The always-run stand-in for the 30s ring timer.
      const caller = await createUser("cldc");
      const callee = await createUser("cldd");
      const conversationId = await createDirect(caller, callee);
      const callerS = await connectAs(caller.api);
      const calleeS = await connectAs(callee.api);

      const ringP = waitFor<RingPayload>(calleeS.socket, "call:ring", (p) => p.conversationId === conversationId);
      const inv = await emitWithAck(callerS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      await ringP;

      const endedP = waitFor<EndedPayload>(callerS.socket, "call:ended", (p) => p.callId === inv.callId);
      calleeS.socket.disconnect();
      expect((await endedP).status).toBe("MISSED");
    });
  });

  describe("ring timeout (env-gated)", () => {
    it.runIf(RING_TIMEOUT_MS <= 8000)("an unanswered ring times out to MISSED", async () => {
      const caller = await createUser("clt1");
      const callee = await createUser("clt2");
      const conversationId = await createDirect(caller, callee);
      const callerS = await connectAs(caller.api);
      const calleeS = await connectAs(callee.api);

      const ringP = waitFor<RingPayload>(calleeS.socket, "call:ring", (p) => p.conversationId === conversationId);
      const t0 = Date.now();
      const inv = await emitWithAck(callerS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      expect(inv.ringTimeoutMs).toBe(RING_TIMEOUT_MS);
      await ringP;

      const endedCallerP = waitFor<EndedPayload>(
        callerS.socket,
        "call:ended",
        (p) => p.callId === inv.callId,
        RING_TIMEOUT_MS + 6000,
      );
      const endedCalleeP = waitFor<EndedPayload>(
        calleeS.socket,
        "call:ended",
        (p) => p.callId === inv.callId,
        RING_TIMEOUT_MS + 6000,
      );
      const [endedCaller, endedCallee] = await Promise.all([endedCallerP, endedCalleeP]);
      expect(endedCaller.status).toBe("MISSED");
      expect(endedCallee.status).toBe("MISSED");
      // Proves the timer actually ran rather than the call ending instantly.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(RING_TIMEOUT_MS - 1500);
    });
  });

  describe("disconnect grace (env-gated)", () => {
    it.runIf(GRACE_MS <= 8000)("an in-call user's last socket dying ends the call after the grace window", async () => {
      const a = await createUser("clg1");
      const b = await createUser("clg2");
      const conversationId = await createDirect(a, b);
      const aS = await connectAs(a.api);
      const bS = await connectAs(b.api);

      const ringP = waitFor<RingPayload>(bS.socket, "call:ring", (p) => p.conversationId === conversationId);
      const inv = await emitWithAck(aS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      await ringP;
      const acc = await emitWithAck(bS.socket, "call:accept", { callId: inv.callId });
      expect(acc.ok).toBe(true);

      const endedP = waitFor<EndedPayload>(aS.socket, "call:ended", (p) => p.callId === inv.callId, GRACE_MS + 8000);
      const t0 = Date.now();
      bS.socket.disconnect();
      expect((await endedP).status).toBe("ENDED");
      expect(Date.now() - t0).toBeGreaterThanOrEqual(GRACE_MS - 1500);
    }, 45_000);

    it.runIf(GRACE_MS <= 8000)("reconnecting within the grace window keeps the call alive", async () => {
      const a = await createUser("clg3");
      const b = await createUser("clg4");
      const conversationId = await createDirect(a, b);
      const aS = await connectAs(a.api);
      const bS = await connectAs(b.api);

      const ringP = waitFor<RingPayload>(bS.socket, "call:ring", (p) => p.conversationId === conversationId);
      const inv = await emitWithAck(aS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      await ringP;
      expect((await emitWithAck(bS.socket, "call:accept", { callId: inv.callId })).ok).toBe(true);

      // Silence spans the whole grace window; the reconnect must cancel it.
      const silence = expectSilence(
        aS.socket,
        "call:ended",
        GRACE_MS + 3000,
        (p) => (p as { callId?: string }).callId === inv.callId,
      );
      bS.socket.disconnect();
      const bAgain = await connectAs(b.api);
      await silence;

      // call:state resync on the fresh socket still sees the live call.
      const state = await emitWithAck(bAgain.socket, "call:state", {});
      expect(state.ok).toBe(true);
      expect(state.self).toBeTruthy();
      expect(state.self.callId).toBe(inv.callId);
      expect(state.self.conversationId).toBe(conversationId);
      expect(state.self.status).toBe("ONGOING");
      expect(state.self.participants.map((u: CallUser) => u.id)).toContain(a.userId);
      expect(state.self.iceServers.length).toBeGreaterThan(0);

      const leave = await emitWithAck(bAgain.socket, "call:leave", { callId: inv.callId });
      expect(leave).toMatchObject({ ok: true, callId: inv.callId, ended: true });
    }, 45_000);
  });

  describe("offline callee", () => {
    it("inviting a fully-offline DIRECT peer answers OFFLINE and writes no rows", async () => {
      const caller = await createUser("cloc");
      const offline = await createUser("clop"); // never connects a socket
      const conversationId = await createDirect(caller, offline);
      const callerS = await connectAs(caller.api);

      const ack = await emitWithAck(callerS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(ack).toMatchObject({ ok: false, code: "OFFLINE" });

      const rows = await db.select().from(schema.call).where(ops.eq(schema.call.conversationId, conversationId));
      expect(rows).toHaveLength(0);
    });
  });

  describe("busy matrix", () => {
    let bz1: FixtureUser; // stays out of the live call — provably not busy
    let bz2: FixtureUser;
    let bz3: FixtureUser;
    let groupId: string;
    let directId: string;
    let s1: SocketSession;
    let s2: SocketSession;
    let s3: SocketSession;
    let liveCallId: string;

    beforeAll(async () => {
      bz1 = await createUser("clb1");
      bz2 = await createUser("clb2");
      bz3 = await createUser("clb3");
      groupId = await createGroup(bz1, [bz2, bz3], "zz e2e busy");
      directId = await createDirect(bz1, bz2);
      s2 = await connectAs(bz2.api);
      s3 = await connectAs(bz3.api);
      // bz1 deliberately offline for the invite: never rung, so no busy mark
      // can ambiguously attach to them before the matrix runs.
      const ringP = waitFor<RingPayload>(s3.socket, "call:ring", (p) => p.conversationId === groupId);
      const inv = await emitWithAck(s2.socket, "call:invite", { conversationId: groupId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      expect(inv.ringingUserIds).toEqual([bz3.userId]); // offline bz1 not rung
      liveCallId = inv.callId;
      await ringP;
      expect((await emitWithAck(s3.socket, "call:accept", { callId: liveCallId })).ok).toBe(true);
      s1 = await connectAs(bz1.api);
    });

    afterAll(async () => {
      // End the live call so no later spec inherits busy users.
      await emitWithAck(s2.socket, "call:leave", { callId: liveCallId }).catch(() => {});
      await emitWithAck(s3.socket, "call:leave", { callId: liveCallId }).catch(() => {});
    });

    it("call:state reports the ongoing call of a conversation the user belongs to", async () => {
      const state = await emitWithAck(s1.socket, "call:state", {});
      expect(state.ok).toBe(true);
      expect(state.self).toBeNull();
      const entry = state.ongoing.find((o: { callId: string }) => o.callId === liveCallId);
      expect(entry).toEqual({ callId: liveCallId, conversationId: groupId, kind: "AUDIO", participantCount: 2 });
    });

    it("CALL_ACTIVE: inviting into a conversation with a live call hands that call back", async () => {
      const ack = await emitWithAck(s1.socket, "call:invite", { conversationId: groupId, kind: "VIDEO" });
      expect(ack.ok).toBe(false);
      expect(ack.code).toBe("CALL_ACTIVE");
      expect(ack.callId).toBe(liveCallId);
      expect(ack.kind).toBe("AUDIO");
    });

    it("PEER_BUSY: a DIRECT invite to someone already in a call", async () => {
      const ack = await emitWithAck(s1.socket, "call:invite", { conversationId: directId, kind: "AUDIO" });
      expect(ack).toMatchObject({ ok: false, code: "PEER_BUSY" });
    });

    it("SELF_BUSY: inviting anywhere while in a call yourself", async () => {
      const ack = await emitWithAck(s2.socket, "call:invite", { conversationId: directId, kind: "AUDIO" });
      expect(ack).toMatchObject({ ok: false, code: "SELF_BUSY" });
    });
  });

  describe("group call", () => {
    let g0: FixtureUser;
    let g1: FixtureUser;
    let g2: FixtureUser;
    let g3: FixtureUser;
    let g4: FixtureUser;
    let groupId: string;
    let s0: SocketSession;
    let s1: SocketSession;
    let s2: SocketSession;
    let s3: SocketSession;
    let s4a: SocketSession;
    let s4b: SocketSession;
    let callId: string;

    beforeAll(async () => {
      g0 = await createUser("clg0");
      g1 = await createUser("clgm1");
      g2 = await createUser("clgm2");
      g3 = await createUser("clgm3");
      g4 = await createUser("clgm4");
      groupId = await createGroup(g0, [g1, g2, g3, g4], "zz e2e call group");
      s0 = await connectAs(g0.api);
      s1 = await connectAs(g1.api);
      s2 = await connectAs(g2.api);
      s3 = await connectAs(g3.api);
      s4a = await connectAs(g4.api);
      s4b = await connectAs(g4.api);
    });

    it("invite rings all members; a group reject stays private; first accept works", async () => {
      const ringPs = [s1, s2, s3, s4a, s4b].map((s) =>
        waitFor<RingPayload>(s.socket, "call:ring", (p) => p.conversationId === groupId),
      );
      const inv = await emitWithAck(s0.socket, "call:invite", { conversationId: groupId, kind: "VIDEO" });
      expect(inv.ok).toBe(true);
      callId = inv.callId;
      expect(sorted(inv.ringingUserIds)).toEqual(sorted([g1, g2, g3, g4].map((u) => u.userId)));
      const rings = await Promise.all(ringPs);
      for (const ring of rings) {
        expect(ring.callId).toBe(callId);
        expect(ring.conversationType).toBe("GROUP");
        expect(ring.kind).toBe("VIDEO");
      }

      // Group reject: only the rejecter's own tabs learn — never the room.
      const handledP = waitFor<{ callId: string; action: string }>(
        s4b.socket,
        "call:ring-handled",
        (p) => p.callId === callId,
      );
      const roomHandledSilence = expectSilence(
        s0.socket,
        "call:ring-handled",
        700,
        (p) => (p as { callId?: string }).callId === callId,
      );
      const roomLeftSilence = expectSilence(
        s0.socket,
        "call:participant-left",
        700,
        (p) => (p as { callId?: string }).callId === callId,
      );
      const rej = await emitWithAck(s4a.socket, "call:reject", { callId });
      expect(rej).toMatchObject({ ok: true, callId });
      expect(await handledP).toEqual({ callId, action: "REJECTED" });
      await Promise.all([roomHandledSilence, roomLeftSilence]);

      const acc = await emitWithAck(s1.socket, "call:accept", { callId });
      expect(acc.ok).toBe(true);
      expect(acc.participants.map((u: CallUser) => u.id)).toEqual([g0.userId]);
    });

    it("joins grow joinedUserIds; the 5th joiner hits CALL_FULL", async () => {
      const joinedP = waitFor<JoinedPayload>(
        s0.socket,
        "call:participant-joined",
        (p) => p.callId === callId && p.user.id === g2.userId,
      );
      const j2 = await emitWithAck(s2.socket, "call:join", { callId });
      expect(j2.ok).toBe(true);
      expect(sorted(j2.participants.map((u: CallUser) => u.id))).toEqual(sorted([g0.userId, g1.userId]));
      const joined = await joinedP;
      expect(sorted(joined.joinedUserIds)).toEqual(sorted([g0, g1, g2].map((u) => u.userId)));

      // Accept-while-ONGOING is a join.
      const j3 = await emitWithAck(s3.socket, "call:accept", { callId });
      expect(j3.ok).toBe(true);
      expect(sorted(j3.participants.map((u: CallUser) => u.id))).toEqual(
        sorted([g0.userId, g1.userId, g2.userId]),
      );

      const full = await emitWithAck(s4a.socket, "call:join", { callId });
      expect(full).toMatchObject({ ok: false, code: "CALL_FULL" });
    });

    it("leaves keep a GROUP call alive down to one, then the last leave ends it", async () => {
      const leftP = waitFor<LeftPayload>(
        s0.socket,
        "call:participant-left",
        (p) => p.callId === callId && p.userId === g3.userId,
      );
      const l3 = await emitWithAck(s3.socket, "call:leave", { callId });
      expect(l3).toMatchObject({ ok: true, callId, ended: false });
      const left = await leftP;
      expect(sorted(left.joinedUserIds)).toEqual(sorted([g0, g1, g2].map((u) => u.userId)));

      expect(await emitWithAck(s2.socket, "call:leave", { callId })).toMatchObject({ ok: true, ended: false });
      // A lone GROUP participant keeps the call.
      expect(await emitWithAck(s1.socket, "call:leave", { callId })).toMatchObject({ ok: true, ended: false });

      const endedP = waitFor<EndedPayload>(s1.socket, "call:ended", (p) => p.callId === callId);
      const bubbleP = waitFor<MessageNew>(s1.socket, "message:new", (p) => p.message?.callId === callId);
      const l0 = await emitWithAck(s0.socket, "call:leave", { callId });
      expect(l0).toMatchObject({ ok: true, callId, ended: true });
      expect((await endedP).status).toBe("ENDED");
      const bubble = (await bubbleP).message;
      expect(bubble.type).toBe("CALL");
      expect(bubble.senderId).toBe(g0.userId);
      expect(JSON.parse(String(bubble.body)).status).toBe("ENDED");
    });
  });

  describe("authz + validation", () => {
    let a1: FixtureUser;
    let a2: FixtureUser;
    let a3: FixtureUser; // member who never joins the call
    let outsider: FixtureUser;
    let groupId: string;
    let sa1: SocketSession;
    let sa2: SocketSession;
    let sa3: SocketSession;
    let sOut: SocketSession;
    let callId: string;

    beforeAll(async () => {
      a1 = await createUser("cla1");
      a2 = await createUser("cla2");
      a3 = await createUser("cla3");
      outsider = await createUser("clax");
      groupId = await createGroup(a1, [a2, a3], "zz e2e authz");
      sa1 = await connectAs(a1.api);
      sa2 = await connectAs(a2.api);
      sa3 = await connectAs(a3.api);
      sOut = await connectAs(outsider.api);
    });

    afterAll(async () => {
      await emitWithAck(sa1.socket, "call:leave", { callId }).catch(() => {});
      await emitWithAck(sa2.socket, "call:leave", { callId }).catch(() => {});
    });

    it("malformed payloads are INVALID; a non-member's invite is NOT_FOUND", async () => {
      // Runs before any live call exists: CALL_ACTIVE is checked before
      // membership, so a live call would answer the outsider differently.
      const badKind = await emitWithAck(sa1.socket, "call:invite", { conversationId: groupId, kind: "SCREEN" });
      expect(badKind).toMatchObject({ ok: false, code: "INVALID" });
      const badId = await emitWithAck(sa1.socket, "call:invite", { conversationId: "nope", kind: "AUDIO" });
      expect(badId).toMatchObject({ ok: false, code: "INVALID" });
      const badCallId = await emitWithAck(sa1.socket, "call:accept", { callId: "nope" });
      expect(badCallId).toMatchObject({ ok: false, code: "INVALID" });

      const stranger = await emitWithAck(sOut.socket, "call:invite", { conversationId: groupId, kind: "AUDIO" });
      expect(stranger).toMatchObject({ ok: false, code: "NOT_FOUND" });
      const nowhere = await emitWithAck(sOut.socket, "call:invite", {
        conversationId: crypto.randomUUID(),
        kind: "AUDIO",
      });
      expect(nowhere).toMatchObject({ ok: false, code: "NOT_FOUND" });
      const ghost = await emitWithAck(sa1.socket, "call:accept", { callId: crypto.randomUUID() });
      expect(ghost).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("a non-member cannot join a live call", async () => {
      const ringP = waitFor<RingPayload>(sa2.socket, "call:ring", (p) => p.conversationId === groupId);
      const inv = await emitWithAck(sa1.socket, "call:invite", { conversationId: groupId, kind: "AUDIO" });
      expect(inv.ok).toBe(true);
      callId = inv.callId;
      await ringP;
      expect((await emitWithAck(sa2.socket, "call:accept", { callId })).ok).toBe(true);

      const join = await emitWithAck(sOut.socket, "call:join", { callId });
      expect(join).toMatchObject({ ok: false, code: "NOT_FOUND" });
    });

    it("rtc:signal from a member who never joined is masked and never relayed", async () => {
      const silence = expectSilence(
        sa1.socket,
        "rtc:signal",
        700,
        (p) => (p as { callId?: string }).callId === callId,
      );
      const ack = await emitWithAck(sa3.socket, "rtc:signal", { callId, to: a1.userId, data: { x: 1 } });
      expect(ack).toMatchObject({ ok: false, code: "NOT_FOUND" });
      await silence;
    });

    it("rtc:signal whose `to` is not a joined participant is rejected and never relayed", async () => {
      const silence = expectSilence(
        sa3.socket,
        "rtc:signal",
        700,
        (p) => (p as { callId?: string }).callId === callId,
      );
      const ack = await emitWithAck(sa1.socket, "rtc:signal", { callId, to: a3.userId, data: { x: 2 } });
      expect(ack).toMatchObject({ ok: false, code: "NOT_FOUND" });
      await silence;
    });
  });

  describe("block gate", () => {
    it("an invite across a block answers byte-identically to a missing conversation", async () => {
      const blocker = await createUser("clk1");
      const blocked = await createUser("clk2");
      // DM created BEFORE the block, so the invite hits the block gate, not
      // the membership gate — same setup 30-search-block uses.
      const conversationId = await createDirect(blocker, blocked);
      const res = await blocker.api.post(`/api/users/${blocked.username}/block`);
      expect(res.status).toBe(200);
      const blockerS = await connectAs(blocker.api);
      const blockedS = await connectAs(blocked.api);

      const missing = await emitWithAck(blockedS.socket, "call:invite", {
        conversationId: crypto.randomUUID(),
        kind: "AUDIO",
      });
      expect(missing).toMatchObject({ ok: false, code: "NOT_FOUND" });

      // The non-committal pin: a block is never a notification, either way.
      const fromBlocked = await emitWithAck(blockedS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(fromBlocked).toEqual(missing);
      const fromBlocker = await emitWithAck(blockerS.socket, "call:invite", { conversationId, kind: "AUDIO" });
      expect(fromBlocker).toEqual(missing);
    });
  });

  describe("invite rate limit", () => {
    it(
      "the 16th invite inside an hour is RATE_LIMITED",
      async () => {
        // The hour limiter is consumed FIRST, before any other check — so an
        // invite that then fails OFFLINE still burns budget, creates no call,
        // and leaves no cleanup. Peers stay disconnected on purpose.
        //
        // Why 8 DMs, round-robin ×2 (not one conversation, not 16 groups):
        // one conversation trips the 20s/2 per-(caller, conversation) redial
        // cooldown — the wrong limiter — and 16 groups trip the app's own
        // 5-groups/day REST cap before the test even starts. 8 DMs sit under
        // the 20/hr DM-start cap and give each conversation exactly 2 uses.
        const caller = await createUser("clrl");
        const dmIds: string[] = [];
        for (let i = 0; i < 8; i++) {
          const peer = await createUser(`clrp${i}`);
          dmIds.push(await createDirect(caller, peer));
        }
        const callerS = await connectAs(caller.api);

        for (let i = 0; i < 15; i++) {
          const inv = await emitWithAck(callerS.socket, "call:invite", {
            conversationId: dmIds[i % dmIds.length],
            kind: "AUDIO",
          });
          expect(inv, `invite ${i + 1} burns budget but fails OFFLINE`).toMatchObject({
            ok: false,
            code: "OFFLINE",
          });
        }

        const capped = await emitWithAck(callerS.socket, "call:invite", {
          conversationId: dmIds[15 % dmIds.length],
          kind: "AUDIO",
        });
        expect(capped).toMatchObject({ ok: false, code: "RATE_LIMITED" });
      },
      60_000,
    );
  });
});
