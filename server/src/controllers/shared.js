const { db, schema, ops } = require("../config/db");

const { conversation, conversationMember, block } = schema;
const { and, eq, ne, or, sql } = ops;

// Helpers shared by the chat and call controllers. Anything here is part of a
// cross-domain contract — think before changing shapes.

const ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

function fail(ack, payload) {
  if (typeof ack === "function") ack({ ok: false, ...payload });
}

// The 18-field wire shape. Two sites must stay identical — this and web's
// toChatMessage: the sorted key set is pinned by tests/specs/00-contracts.spec.ts.
function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    body: row.body,
    mediaUrl: row.mediaUrl,
    mediaMime: row.mediaMime,
    mediaSize: row.mediaSize,
    mediaName: row.mediaName,
    mediaWidth: row.mediaWidth,
    mediaHeight: row.mediaHeight,
    mediaDurationMs: row.mediaDurationMs,
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

/**
 * Is messaging/calling into this conversation blocked?
 *
 * Written so it needs nothing but (conversationId, userId) — no prior knowledge
 * of who the other person is — which is the point: it can then run in PARALLEL
 * with the membership lookup instead of after it, so the block gate costs a DM
 * send no extra wall-clock at all.
 *
 * Checks BOTH directions. A blocker who could still be messaged by the person
 * they blocked has not blocked them in any useful sense.
 *
 * DIRECT only, enforced by the join on conversation.type. In a group, one
 * member blocking another must not silently break the group for everybody —
 * hiding a blocked member's messages there is a read-side concern.
 */
async function sendIsBlocked(conversationId, userId) {
  const rows = await db
    .select({ one: sql`1` })
    .from(conversationMember)
    .innerJoin(
      conversation,
      and(eq(conversation.id, conversationMember.conversationId), eq(conversation.type, "DIRECT")),
    )
    .innerJoin(
      block,
      or(
        and(eq(block.blockerId, userId), eq(block.blockedId, conversationMember.userId)),
        and(eq(block.blockerId, conversationMember.userId), eq(block.blockedId, userId)),
      ),
    )
    .where(and(eq(conversationMember.conversationId, conversationId), ne(conversationMember.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

module.exports = { ID_PATTERN, fail, serializeMessage, sendIsBlocked };
