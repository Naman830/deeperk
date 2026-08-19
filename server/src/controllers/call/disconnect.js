const { db, schema, ops } = require("../../config/db");
const { env } = require("../../config/env");
const presence = require("../../services/presence");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { endsWithoutUser } = require("./shared");
const { endCall } = require("./end-call");

const { callParticipant } = schema;
const { and, eq, sql } = ops;

function startGraceTimer(io, record, userId) {
  const timer = setTimeout(() => {
    activeCalls.clearGraceTimer(record.id, userId);
    // Advisory timer — re-check everything against the state machine.
    if (activeCalls.get(record.id) !== record || record.terminal) return;
    if (!activeCalls.isJoined(record.id, userId)) return;
    if (presence.count(userId) > 0) return; // reconnected
    const { joinedRemaining } = activeCalls.markLeft(record.id, userId);
    if (endsWithoutUser(record, joinedRemaining)) {
      endCall(io, record, record.status === "RINGING" ? "MISSED" : "ENDED").catch((error) =>
        console.error("[call:grace-end]", error),
      );
      return;
    }
    db.update(callParticipant)
      .set({ leftAt: sql`now()` })
      .where(and(eq(callParticipant.callId, record.id), eq(callParticipant.userId, userId)))
      .then(() => {})
      .catch((error) => console.error("[call:grace-left]", error));
    notify.toConversation(io, record.conversationId, "call:participant-left", {
      callId: record.id,
      conversationId: record.conversationId,
      userId,
      joinedUserIds: activeCalls.joinedUserIds(record.id),
    });
  }, env.CALL_DISCONNECT_GRACE_MS);
  timer.unref();
  activeCalls.setGraceTimer(record.id, userId, timer);
}

// Registered BEFORE socket/connection.js's disconnecting listener (registration
// order = firing order), so presence still counts THIS socket:
// count <= 1 means this was the user's last tab. Load-bearing ordering.
function registerDisconnectHandler(io, socket) {
  const userId = socket.data.user.id;

  socket.on("disconnecting", () => {
    try {
      if (presence.count(userId) > 1) return; // another tab still signals

      const callId = activeCalls.callIdOf(userId);
      const record = callId ? activeCalls.get(callId) : null;
      if (record && !record.terminal) {
        if (record.status === "RINGING" && record.startedById === userId) {
          // The ringing caller's last socket died: nobody left to answer to.
          endCall(io, record, "MISSED").catch((error) => console.error("[call:disconnect-end]", error));
        } else {
          // P2P media outlives the signaling socket — grace, not an instant
          // leave. Any new socket for this user clears it (see index.js).
          startGraceTimer(io, record, userId);
        }
      }

      // Rung but not joined: a DIRECT ring dies with the callee (§2.3), a
      // group callee just falls out of the rung set.
      for (const ringing of activeCalls.ringsFor(userId)) {
        if (ringing.conversationType === "DIRECT") {
          endCall(io, ringing, "MISSED").catch((error) => console.error("[call:disconnect-missed]", error));
        } else {
          const { rungRemaining } = activeCalls.markRungGone(ringing.id, userId);
          if (ringing.status === "RINGING" && rungRemaining === 0) {
            endCall(io, ringing, "MISSED").catch((error) => console.error("[call:disconnect-missed]", error));
          }
        }
      }
    } catch (error) {
      console.error("[call:disconnecting]", error);
    }
  });
}

module.exports = { registerDisconnectHandler };
