const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../../config/db");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { serializeMessage } = require("../shared");

const { conversation, message, call, callParticipant } = schema;
const { and, eq, sql, isNull, isNotNull } = ops;

/**
 * The one finalizer. beginTerminal is a sync check-and-set BEFORE the first
 * await, so exactly one of the racing terminal paths (leave/cancel/timeout/
 * disconnect/kick) runs it.
 */
async function endCall(io, record, status) {
  if (!activeCalls.beginTerminal(record.id)) return;
  try {
    // Talk time, not ring time — and app clock on both sides (answeredAt is
    // Date.now() from markJoined), per the repo's clock-discipline rule.
    const durationSec =
      status === "ENDED" && record.answeredAt
        ? Math.round((Date.now() - record.answeredAt) / 1000)
        : null;
    // Ordered so each later statement's loss is strictly more cosmetic:
    // status flip > leftAt stamps > history bubble > sidebar re-sort.
    const results = await db.batch([
      db.update(call).set({ status, endedAt: sql`now()` }).where(eq(call.id, record.id)),
      db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(
          and(
            eq(callParticipant.callId, record.id),
            isNotNull(callParticipant.joinedAt),
            isNull(callParticipant.leftAt),
          ),
        ),
      db
        .insert(message)
        .values({
          id: randomUUID(),
          conversationId: record.conversationId,
          senderId: record.startedById,
          type: "CALL",
          callId: record.id,
          body: JSON.stringify({ status, kind: record.kind, durationSec }),
          clientMsgId: null,
        })
        .returning(),
      db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, record.conversationId)),
    ]);

    notify.toConversation(io, record.conversationId, "call:ended", {
      callId: record.id,
      conversationId: record.conversationId,
      status,
      endedAt: new Date().toISOString(),
    });
    const inserted = results[2];
    if (inserted && inserted[0]) {
      // Buys the whole chat.md §6 pipeline: previews, badges, toasts.
      notify.toConversation(io, record.conversationId, "message:new", {
        conversationId: record.conversationId,
        message: serializeMessage(inserted[0]),
      });
    }
  } catch (error) {
    console.error("[call:end]", error);
  } finally {
    // Always free the slot — a leaked byConversation entry permanently blocks
    // this conversation's calls.
    activeCalls.remove(record.id);
  }
}

module.exports = { endCall };
