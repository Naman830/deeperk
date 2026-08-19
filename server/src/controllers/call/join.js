const { db, schema, ops } = require("../../config/db");
const { env } = require("../../config/env");
const { requireMembership } = require("../../services/rooms");
const { allow } = require("../../services/rate-limit");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");
const { MAX_JOINED, INVALID, NOT_FOUND, listMembers, toCallUser } = require("./shared");

const { call, callParticipant } = schema;
const { and, eq, sql, isNull } = ops;

/** Shared by call:accept and call:join — accept-while-ONGOING IS a join. */
async function joinCall(io, socket, payload, ack) {
  const userId = socket.data.user.id;
  try {
    const callId = payload && payload.callId;
    if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
    if (!allow(`callctl:${userId}`, 10_000, 20)) {
      return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
    }

    const record = activeCalls.get(callId);
    if (!record || record.terminal) return fail(ack, NOT_FOUND);
    // Cheap in-memory pre-checks before the DB round trip (re-checked after).
    const busyIn = activeCalls.callIdOf(userId);
    if (busyIn && busyIn !== callId) {
      return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
    }
    if (!activeCalls.isJoined(callId, userId) && activeCalls.joinedCount(callId) >= MAX_JOINED) {
      return fail(ack, { code: "CALL_FULL", error: "This call is full." });
    }

    // Fresh from the DB, never socket.rooms — same rule as the chat controller.
    const [membership, info] = await Promise.all([
      requireMembership(record.conversationId, userId),
      listMembers(record.conversationId),
    ]);
    if (!membership || !info) return fail(ack, NOT_FOUND);

    // Re-check + markJoined with zero await between them: on Node's single
    // thread nothing can interleave, so the busy mark and the 4-slot cap are
    // reserved atomically.
    if (activeCalls.get(callId) !== record || record.terminal) return fail(ack, NOT_FOUND);
    const busyNow = activeCalls.callIdOf(userId);
    if (busyNow && busyNow !== callId) {
      return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
    }
    const alreadyJoined = activeCalls.isJoined(callId, userId);
    if (!alreadyJoined && activeCalls.joinedCount(callId) >= MAX_JOINED) {
      return fail(ack, { code: "CALL_FULL", error: "This call is full." });
    }
    const { becameOngoing } = activeCalls.markJoined(callId, userId);

    // COALESCE keeps the FIRST join time (the /calls duration derives from
    // it); leftAt cleared so a grace re-join un-leaves.
    const statements = [
      db
        .insert(callParticipant)
        .values({ callId, userId, joinedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [callParticipant.callId, callParticipant.userId],
          set: { joinedAt: sql`COALESCE(${callParticipant.joinedAt}, now())`, leftAt: null },
        }),
    ];
    if (becameOngoing) {
      // Conditional so a late-landing batch can never resurrect a call a
      // racing terminal path already stamped ENDED/MISSED in the DB.
      statements.push(
        db.update(call).set({ status: "ONGOING" }).where(and(eq(call.id, callId), eq(call.status, "RINGING"))),
      );
    }
    try {
      await db.batch(statements);
    } catch (error) {
      // Roll back the FULL in-memory reservation, or the user is "busy"
      // forever and (worse) an ONGOING flip with a RINGING row breaks cancel.
      if (!alreadyJoined) activeCalls.markLeft(callId, userId);
      if (becameOngoing) activeCalls.revertOngoing(callId);
      throw error;
    }

    // A terminal path may have won while our batch was in flight; its leftAt
    // stamp ran before our upsert re-nulled it — restamp and bail.
    if (record.terminal || activeCalls.get(callId) !== record) {
      await db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(
          and(eq(callParticipant.callId, callId), eq(callParticipant.userId, userId), isNull(callParticipant.leftAt)),
        );
      return fail(ack, NOT_FOUND);
    }

    const joinedIds = activeCalls.joinedUserIds(callId);
    const byId = new Map(info.members.map((m) => [m.id, m]));
    const self = byId.get(userId);
    // Ack BEFORE the room broadcast: both ride the joiner's socket in order,
    // and the client must process its join result before its own echo of
    // call:participant-joined (or an accepting tab reads the echo as "another
    // tab answered" and tears itself down).
    if (typeof ack === "function") {
      ack({
        ok: true,
        callId,
        conversationId: record.conversationId,
        kind: record.kind,
        participants: joinedIds
          .filter((id) => id !== userId)
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map(toCallUser),
        iceServers: env.ICE_SERVERS,
      });
    }
    // ALWAYS broadcast, re-joins included: this event is the §2.4 offer rule
    // and the reconnect re-peer mechanism — incumbents re-offer to this user.
    notify.toConversation(io, record.conversationId, "call:participant-joined", {
      callId,
      conversationId: record.conversationId,
      user: self ? toCallUser(self) : { id: userId, username: socket.data.user.username, firstName: null, lastName: null, avatarPublicId: null },
      joinedUserIds: joinedIds,
    });
  } catch (error) {
    console.error("[call:join]", error);
    fail(ack, { code: "SERVER_ERROR", error: "Couldn't join the call. Try again." });
  }
}

function registerJoinHandlers(io, socket) {
  socket.on("call:accept", (payload, ack) => joinCall(io, socket, payload, ack));
  socket.on("call:join", (payload, ack) => joinCall(io, socket, payload, ack));
}

module.exports = { registerJoinHandlers };
