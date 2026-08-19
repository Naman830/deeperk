const { db, schema, ops } = require("../../config/db");
const { env } = require("../../config/env");
const { allow } = require("../../services/rate-limit");
const activeCalls = require("../../services/active-calls");
const { fail } = require("../shared");
const { listMembers, toCallUser } = require("./shared");

const { conversationMember } = schema;
const { and, eq, inArray } = ops;

// Resync after connect/reconnect: the user's own live call plus every live
// call in a conversation they belong to (join banners).
function registerStateHandler(io, socket) {
  const userId = socket.data.user.id;

  socket.on("call:state", async (payload, ack) => {
    try {
      if (!allow(`callstate:${userId}`, 10_000, 30)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const live = activeCalls.liveCalls().filter((record) => !record.terminal);

      // One membership query over the small live-call set — this is also the
      // fresh-from-DB authz for everything the ack reveals, self included.
      let memberOf = new Set();
      if (live.length > 0) {
        const rows = await db
          .select({ conversationId: conversationMember.conversationId })
          .from(conversationMember)
          .where(
            and(
              eq(conversationMember.userId, userId),
              inArray(conversationMember.conversationId, live.map((record) => record.conversationId)),
            ),
          );
        memberOf = new Set(rows.map((row) => row.conversationId));
      }
      const mine = live.filter((record) => memberOf.has(record.conversationId));
      const ongoing = mine.map((record) => ({
        callId: record.id,
        conversationId: record.conversationId,
        kind: record.kind,
        participantCount: activeCalls.joinedCount(record.id),
      }));

      const selfCallId = activeCalls.callIdOf(userId);
      const selfRecord = selfCallId ? mine.find((record) => record.id === selfCallId) : null;
      let self = null;
      if (selfRecord) {
        const info = await listMembers(selfRecord.conversationId);
        const byId = new Map((info ? info.members : []).map((m) => [m.id, m]));
        self = {
          callId: selfRecord.id,
          conversationId: selfRecord.conversationId,
          kind: selfRecord.kind,
          status: selfRecord.status,
          // Excluding self, same convention as the accept/join ack — the
          // client renders participants as remote tiles.
          participants: activeCalls
            .joinedUserIds(selfRecord.id)
            .filter((id) => id !== userId)
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map(toCallUser),
          iceServers: env.ICE_SERVERS,
        };
      }
      if (typeof ack === "function") ack({ ok: true, self, ongoing });
    } catch (error) {
      console.error("[call:state]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't sync call state." });
    }
  });
}

module.exports = { registerStateHandler };
