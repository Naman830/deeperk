const { db, schema, ops } = require("../../config/db");
const { allow, LIMITS } = require("../../services/rate-limit");
const presence = require("../../services/presence");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");
const { NOT_FOUND } = require("./shared");

const { conversationMember } = schema;
const { and, eq, sql } = ops;

function registerReceiptHandlers(io, socket) {
  const userId = socket.data.user.id;

  // The middle tick. Emitted by a RECIPIENT when a message reaches their
  // client, which is information no other party can produce.
  socket.on("conversation:delivered", async (payload) => {
    try {
      const conversationId = payload && payload.conversationId;
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) return;
      if (!allow(`dlv:${userId}:${conversationId}`, LIMITS.delivered.windowMs, LIMITS.delivered.max)) return;

      // GREATEST for the same reason as lastReadAt: concurrent writes from two
      // tabs must not move the watermark backwards. The WHERE is the
      // authorization — zero rows means not a member.
      const updated = await db
        .update(conversationMember)
        .set({
          lastDeliveredAt: sql`GREATEST(COALESCE(${conversationMember.lastDeliveredAt}, 'epoch'::timestamptz), now())`,
        })
        .where(and(eq(conversationMember.conversationId, conversationId), eq(conversationMember.userId, userId)))
        .returning({ lastDeliveredAt: conversationMember.lastDeliveredAt });

      if (updated.length === 0) return;

      // Gated on the same privacy setting as read receipts and presence: a
      // person who hides their activity must not leak a delivery timestamp
      // either. Server-side, never client-side (chat.md §2.6).
      if (!(await presence.readsPresencePublicly(userId))) return;

      notify.toConversationExceptSender(socket, conversationId, "conversation:delivered", {
        conversationId,
        userId,
        lastDeliveredAt: updated[0].lastDeliveredAt ? updated[0].lastDeliveredAt.toISOString() : null,
      });
    } catch (error) {
      console.error("[chat:conversation-delivered]", error);
    }
  });

  socket.on("conversation:read", async (payload, ack) => {
    try {
      const conversationId = payload && payload.conversationId;
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
      // §7 says this isn't rate limited. This is a runaway-client guard, not a
      // security control — it is still an UPDATE, and idempotent isn't free.
      if (!allow(`read:${userId}:${conversationId}`, LIMITS.read.windowMs, LIMITS.read.max)) {
        return;
      }

      // GREATEST keeps it monotonic, so concurrent writes can't move the
      // watermark backwards. The WHERE clause is the authorization: zero rows
      // means not a member, so no separate membership query is needed.
      const updated = await db
        .update(conversationMember)
        .set({ lastReadAt: sql`GREATEST(COALESCE(${conversationMember.lastReadAt}, 'epoch'::timestamptz), now())` })
        .where(and(eq(conversationMember.conversationId, conversationId), eq(conversationMember.userId, userId)))
        .returning({ lastReadAt: conversationMember.lastReadAt });

      if (updated.length === 0) return fail(ack, NOT_FOUND);

      const lastReadAt = updated[0].lastReadAt ? updated[0].lastReadAt.toISOString() : null;
      // This user's own other tabs: clear the badge everywhere they are signed in.
      socket.to(`user:${userId}`).emit("conversation:read-sync", { conversationId, lastReadAt });
      if (typeof ack === "function") ack({ ok: true, conversationId, lastReadAt });

      // AND the room, which is new — chat.md §4 used to defer per-person read
      // receipts, and this is the deliberate departure that makes the blue
      // double-tick possible.
      //
      // Gated on the reader's own onlineStatus privacy: someone who hides their
      // presence must not leak a read timestamp, which is strictly more
      // revealing than "online". Decided server-side and never sent, rather than
      // sent and hidden client-side — chat.md §2.6's standing rule.
      if (!(await presence.readsPresencePublicly(userId))) return;
      notify.toConversationExceptSender(socket, conversationId, "conversation:read-by", {
        conversationId,
        userId,
        lastReadAt,
      });
    } catch (error) {
      console.error("[chat:conversation-read]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Something went wrong." });
    }
  });
}

module.exports = { registerReceiptHandlers };
