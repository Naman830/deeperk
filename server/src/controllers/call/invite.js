const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../../config/db");
const { env } = require("../../config/env");
const { requireMembership } = require("../../services/rooms");
const { allow } = require("../../services/rate-limit");
const presence = require("../../services/presence");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { ID_PATTERN, fail, sendIsBlocked } = require("../shared");
const { CALL_KINDS, INVALID, CONVERSATION_NOT_FOUND, BLOCKED, failCallActive, listMembers } = require("./shared");
const { endCall } = require("./end-call");

const { call, callParticipant } = schema;
const { and, eq, sql, isNull, isNotNull } = ops;

// 15 invites/hour. NOT rate-limit.js's allow(): its sweeper evicts buckets
// idle >5min, so an hour-long window would silently reset. This map is swept
// on window expiry only.
const INVITE_WINDOW_MS = 60 * 60_000;
const INVITE_MAX = 15;
const inviteBuckets = new Map(); // userId -> {windowStart, count}

function allowInvite(userId) {
  const now = Date.now();
  const bucket = inviteBuckets.get(userId);
  if (!bucket || now - bucket.windowStart >= INVITE_WINDOW_MS) {
    inviteBuckets.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= INVITE_MAX;
}

const inviteSweeper = setInterval(() => {
  const cutoff = Date.now() - INVITE_WINDOW_MS;
  for (const [key, bucket] of inviteBuckets) {
    if (bucket.windowStart < cutoff) inviteBuckets.delete(key);
  }
}, 10 * 60_000);
inviteSweeper.unref();

function registerInviteHandler(io, socket) {
  const userId = socket.data.user.id;

  socket.on("call:invite", async (payload, ack) => {
    try {
      if (!payload || typeof payload !== "object") return fail(ack, INVALID);
      const { conversationId, kind } = payload;
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) return fail(ack, INVALID);
      if (!CALL_KINDS.has(kind)) return fail(ack, INVALID);

      if (!allowInvite(userId)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Too many calls in the last hour." });
      }
      // Re-invite cooldown: allows one immediate redial, blocks ring spam.
      if (!allow(`callconv:${userId}:${conversationId}`, 20_000, 2)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Give them a moment before calling again." });
      }

      // Cheap in-memory pre-checks before the DB round trips (re-checked after).
      if (activeCalls.callIdOf(userId)) {
        return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
      }
      const existing = activeCalls.getByConversation(conversationId);
      if (existing) return failCallActive(ack, existing);

      const [membership, info, blocked] = await Promise.all([
        requireMembership(conversationId, userId),
        listMembers(conversationId),
        sendIsBlocked(conversationId, userId),
      ]);
      if (!membership || !info) return fail(ack, CONVERSATION_NOT_FOUND);
      // Masked as NOT_FOUND — reported to the caller as the offline case,
      // never "blocked".
      if (blocked) return fail(ack, BLOCKED);

      // From here to create() everything is synchronous: the re-checks and the
      // reservation cannot interleave with another handler, which is what
      // closes the two-invites-into-one-conversation race.
      if (activeCalls.callIdOf(userId)) {
        return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
      }
      const raced = activeCalls.getByConversation(conversationId);
      if (raced) return failCallActive(ack, raced);

      // Online filter is live presence, not the laggy user.isOnline column.
      const rung = info.members.filter((m) => m.id !== userId && presence.count(m.id) > 0);
      if (rung.length === 0) {
        return fail(ack, {
          code: "OFFLINE",
          error: info.type === "DIRECT" ? "They're offline right now." : "Nobody is online right now.",
        });
      }
      if (info.type === "DIRECT" && rung.some((m) => activeCalls.callIdOf(m.id))) {
        return fail(ack, { code: "PEER_BUSY", error: "They're on another call." });
      }

      const callId = randomUUID();
      // Reservation BEFORE the insert (busy mark + the one-live-call-per-
      // conversation slot); rolled back on the failure path below.
      const record = activeCalls.create({
        id: callId,
        conversationId,
        conversationType: info.type,
        kind,
        startedById: userId,
        rungUserIds: rung.map((m) => m.id),
      });

      try {
        // Offline members get NO participant row.
        await db.batch([
          db.insert(call).values({ id: callId, conversationId, startedById: userId, kind, status: "RINGING" }),
          db.insert(callParticipant).values([
            { callId, userId, joinedAt: sql`now()` },
            ...rung.map((m) => ({ callId, userId: m.id, joinedAt: null })),
          ]),
        ]);
      } catch (error) {
        activeCalls.remove(callId);
        throw error;
      }

      // The caller's last socket can die while the insert is in flight: the
      // disconnect path ran endCall against rows that didn't exist yet (its
      // batch threw on the message FK), so the rows our batch just created are
      // orphans — stamp them terminal and neither ring nor arm the timer.
      if (record.terminal || activeCalls.get(callId) !== record) {
        await db.batch([
          db.update(call).set({ status: "MISSED", endedAt: sql`now()` }).where(eq(call.id, callId)),
          db
            .update(callParticipant)
            .set({ leftAt: sql`now()` })
            .where(
              and(eq(callParticipant.callId, callId), isNotNull(callParticipant.joinedAt), isNull(callParticipant.leftAt)),
            ),
        ]);
        return;
      }

      // Advisory timer; the state machine is the truth, so re-check first.
      const ringTimer = setTimeout(() => {
        activeCalls.clearRingTimer(callId);
        const live = activeCalls.get(callId);
        if (!live || live.terminal) return;
        if (live.status === "RINGING") {
          endCall(io, live, "MISSED").catch((error) => console.error("[call:ring-timeout]", error));
          return;
        }
        // Ring window closed but the call goes on — dismiss pending modals.
        notify.toUsers(io, activeCalls.rungPendingUserIds(callId), "call:ring-cancelled", {
          callId,
          conversationId,
        });
      }, env.CALL_RING_TIMEOUT_MS);
      ringTimer.unref();
      activeCalls.setRingTimer(callId, ringTimer);

      const caller = info.members.find((m) => m.id === userId);
      const startedAt = record.startedAt.toISOString();
      // Per rung member's user room, computed from the fresh SELECT — NEVER
      // the conversation room, whose Socket.IO membership can be stale.
      for (const m of rung) {
        notify.toUsers(io, [m.id], "call:ring", {
          callId,
          conversationId,
          conversationType: info.type,
          conversationName: info.name,
          kind,
          caller,
          startedAt,
          ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
        });
      }
      notify.toConversation(io, conversationId, "call:started", {
        callId,
        conversationId,
        kind,
        startedById: userId,
        startedAt,
      });
      if (typeof ack === "function") {
        ack({
          ok: true,
          callId,
          conversationId,
          kind,
          ringingUserIds: rung.map((m) => m.id),
          iceServers: env.ICE_SERVERS,
          ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
        });
      }
    } catch (error) {
      console.error("[call:invite]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't start the call. Try again." });
    }
  });
}

module.exports = { registerInviteHandler };
