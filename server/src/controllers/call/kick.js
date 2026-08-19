const { db, schema, ops } = require("../../config/db");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { endsWithoutUser } = require("./shared");
const { endCall } = require("./end-call");

const { callParticipant } = schema;
const { and, eq, sql, inArray } = ops;

/**
 * Member removal (routes/internal.js members.removed) force-leaves users from
 * the conversation's live call; a pending ring is dismissed on their own tabs.
 */
async function kickFromConversationCall(io, userIds, conversationId) {
  const record = activeCalls.getByConversation(conversationId);
  if (!record || record.terminal) return;

  const leftUserIds = [];
  let ends = false;
  for (const userId of userIds) {
    if (activeCalls.isJoined(record.id, userId)) {
      const { joinedRemaining } = activeCalls.markLeft(record.id, userId);
      leftUserIds.push(userId);
      if (endsWithoutUser(record, joinedRemaining)) ends = true;
    } else if (activeCalls.rungPendingUserIds(record.id).includes(userId)) {
      const { rungRemaining } = activeCalls.markRungGone(record.id, userId);
      notify.toUsers(io, [userId], "call:ring-cancelled", { callId: record.id, conversationId });
      if (record.status === "RINGING" && rungRemaining === 0) ends = true;
    }
  }

  if (ends) {
    const status = record.status === "RINGING" ? "MISSED" : "ENDED";
    await endCall(io, record, status);
    // endCall broadcasts to the conversation room, which the kicked users may
    // already have been removed from — tell them directly too.
    if (leftUserIds.length > 0) {
      notify.toUsers(io, leftUserIds, "call:ended", {
        callId: record.id,
        conversationId,
        status,
        endedAt: new Date().toISOString(),
      });
    }
    return;
  }
  if (leftUserIds.length === 0) return;
  await db
    .update(callParticipant)
    .set({ leftAt: sql`now()` })
    .where(and(eq(callParticipant.callId, record.id), inArray(callParticipant.userId, leftUserIds)));
  for (const userId of leftUserIds) {
    const payload = {
      callId: record.id,
      conversationId,
      userId,
      joinedUserIds: activeCalls.joinedUserIds(record.id),
    };
    notify.toConversation(io, conversationId, "call:participant-left", payload);
    // The kicked user's own tabs are likely out of the room already — their
    // force-leave teardown depends on this direct copy (duplicates are fine,
    // the client's handling is idempotent).
    notify.toUsers(io, [userId], "call:participant-left", payload);
  }
}

module.exports = { kickFromConversationCall };
