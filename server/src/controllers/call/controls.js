const { db, schema, ops } = require("../../config/db");
const { allow } = require("../../services/rate-limit");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");
const { INVALID, NOT_FOUND, endsWithoutUser } = require("./shared");
const { endCall } = require("./end-call");

const { callParticipant } = schema;
const { and, eq, sql } = ops;

// The caller-side and callee-side lifecycle controls: cancel, reject, leave.
function registerControlHandlers(io, socket) {
  const userId = socket.data.user.id;

  socket.on("call:cancel", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      // Caller + RINGING only; every other answer is the same NOT_FOUND.
      if (!record || record.terminal || record.startedById !== userId || record.status !== "RINGING") {
        return fail(ack, NOT_FOUND);
      }
      await endCall(io, record, "MISSED");
      if (typeof ack === "function") ack({ ok: true, callId });
    } catch (error) {
      console.error("[call:cancel]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't cancel the call." });
    }
  });

  socket.on("call:reject", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      // Rung and un-joined only.
      if (!record || record.terminal || !activeCalls.rungPendingUserIds(callId).includes(userId)) {
        return fail(ack, NOT_FOUND);
      }
      const { rungRemaining } = activeCalls.markRejected(callId, userId);
      if (record.conversationType === "DIRECT") {
        await endCall(io, record, "REJECTED");
      } else {
        // The rejecter's own other tabs dismiss their ring; the room learns
        // nothing — declining a group call is not a broadcastable act.
        socket.to(`user:${userId}`).emit("call:ring-handled", { callId, action: "REJECTED" });
        if (record.status === "RINGING" && rungRemaining === 0) {
          // Group ring-outs are always MISSED, even when everyone declined.
          await endCall(io, record, "MISSED");
        }
      }
      if (typeof ack === "function") ack({ ok: true, callId });
    } catch (error) {
      console.error("[call:reject]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't decline the call." });
    }
  });

  socket.on("call:leave", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      if (!record || record.terminal || !activeCalls.isJoined(callId, userId)) {
        return fail(ack, NOT_FOUND);
      }
      const { joinedRemaining } = activeCalls.markLeft(callId, userId);
      if (endsWithoutUser(record, joinedRemaining)) {
        // The caller leaving an unanswered call is a cancel in all but name.
        await endCall(io, record, record.status === "RINGING" ? "MISSED" : "ENDED");
        if (typeof ack === "function") ack({ ok: true, callId, ended: true });
        return;
      }
      await db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(and(eq(callParticipant.callId, callId), eq(callParticipant.userId, userId)));
      notify.toConversation(io, record.conversationId, "call:participant-left", {
        callId,
        conversationId: record.conversationId,
        userId,
        joinedUserIds: activeCalls.joinedUserIds(callId),
      });
      if (typeof ack === "function") ack({ ok: true, callId, ended: false });
    } catch (error) {
      console.error("[call:leave]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't leave the call." });
    }
  });
}

module.exports = { registerControlHandlers };
