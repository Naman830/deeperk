const { db, schema, ops } = require("../../config/db");
const { allow, LIMITS } = require("../../services/rate-limit");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");

const { conversationMember, message, messageDeletion } = schema;
const { and, eq, inArray, sql } = ops;

// A multi-select delete arrives as an array; a single delete still arrives as
// one id. Both shapes are accepted rather than the old one being replaced —
// socket.io buffers emits across a reconnect, so an in-flight single-id emit
// must keep working.
const MAX_BULK_DELETE = 50;

function idsFrom(payload) {
  if (!payload || typeof payload !== "object") return null;
  const raw = Array.isArray(payload.messageIds)
    ? payload.messageIds
    : payload.messageId !== undefined
      ? [payload.messageId]
      : null;
  if (!raw || raw.length === 0 || raw.length > MAX_BULK_DELETE) return null;
  if (!raw.every((id) => typeof id === "string" && ID_PATTERN.test(id))) return null;
  return [...new Set(raw)];
}

function registerDeleteHandlers(io, socket) {
  const userId = socket.data.user.id;

  socket.on("message:delete", async (payload, ack) => {
    try {
      // Accepts { messageId } and { messageIds: [...] } alike — see idsFrom.
      const ids = idsFrom(payload);
      if (!ids) return fail(ack, { code: "INVALID", error: "Invalid request." });
      if (!allow(`del:${userId}`, LIMITS.delete.windowMs, LIMITS.delete.max)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }

      // Own messages only, and "someone else's message" answers the same as
      // "no such message" so the existence of one can't be probed.
      const deleted = await db
        .update(message)
        .set({
          deletedAt: sql`now()`,
          // Nulling the content is what makes "delete for everyone" real. A
          // tombstone that still carried its body would be a soft delete of the
          // UI, not of the data. mediaPublicId is kept so a sweep can destroy
          // the asset — Cloudinary credentials deliberately live only in Next.
          body: null,
          mediaUrl: null,
          mediaMime: null,
          mediaSize: null,
          mediaName: null,
          mediaWidth: null,
          mediaHeight: null,
        })
        .where(and(inArray(message.id, ids), eq(message.senderId, userId)))
        .returning({
          id: message.id,
          conversationId: message.conversationId,
          deletedAt: message.deletedAt,
        });

      if (deleted.length === 0) return fail(ack, { code: "NOT_FOUND", error: "Message not found." });

      // One event per message rather than one carrying an array: every existing
      // client listens for the single-id shape, and a bulk delete is at most 50.
      for (const row of deleted) {
        const deletedAt = row.deletedAt ? row.deletedAt.toISOString() : new Date().toISOString();
        notify.toConversation(io, row.conversationId, "message:deleted", {
          conversationId: row.conversationId,
          messageId: row.id,
          deletedAt,
        });
      }
      if (typeof ack === "function") {
        ack({ ok: true, messageIds: deleted.map((row) => row.id), messageId: deleted[0].id });
      }
    } catch (error) {
      console.error("[chat:message-delete]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't delete that. Try again." });
    }
  });

  // "Delete for me" — hides messages for this user alone. The complement of
  // message:delete above: that one is a tombstone the whole room sees, this one
  // is invisible to everybody else, including the sender of the message.
  socket.on("message:delete-for-me", async (payload, ack) => {
    try {
      const ids = idsFrom(payload);
      if (!ids) return fail(ack, { code: "INVALID", error: "Invalid request." });
      if (!allow(`delfm:${userId}`, LIMITS.deleteForMe.windowMs, LIMITS.deleteForMe.max)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }

      // Authorization is membership of the message's conversation, NOT
      // ownership — you may hide anyone's message, that is the whole point.
      // One join rather than fetch-then-check: it is a single round trip, and
      // "no such message" and "not a member" collapse into one answer, so a
      // message id still can't be probed for existence.
      const rows = await db
        .select({ id: message.id, conversationId: message.conversationId })
        .from(message)
        .innerJoin(
          conversationMember,
          and(
            eq(conversationMember.conversationId, message.conversationId),
            eq(conversationMember.userId, userId),
          ),
        )
        .where(inArray(message.id, ids));

      if (rows.length === 0) return fail(ack, { code: "NOT_FOUND", error: "Message not found." });

      // onConflictDoNothing, not a plain insert: the composite PK makes this
      // idempotent, so a double-tap or a retry after a dropped ack is a no-op
      // rather than a 23505 the client would surface as a failure.
      await db
        .insert(messageDeletion)
        .values(rows.map((row) => ({ messageId: row.id, userId })))
        .onConflictDoNothing();

      // This user's own other tabs only — never the conversation room. Nobody
      // else may learn that a message was hidden.
      for (const row of rows) {
        socket.to(`user:${userId}`).emit("message:hidden", {
          conversationId: row.conversationId,
          messageId: row.id,
        });
      }
      // conversationId comes back in the ack because the acting tab needs it to
      // apply the hide locally — it is the one socket that does NOT receive the
      // message:hidden broadcast above.
      if (typeof ack === "function") {
        ack({
          ok: true,
          messageId: rows[0].id,
          messageIds: rows.map((row) => row.id),
          conversationId: rows[0].conversationId,
        });
      }
    } catch (error) {
      console.error("[chat:message-delete-for-me]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't remove that. Try again." });
    }
  });
}

module.exports = { registerDeleteHandlers };
