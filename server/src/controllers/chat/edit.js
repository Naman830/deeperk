const { db, schema, ops } = require("../../config/db");
const { allow, LIMITS } = require("../../services/rate-limit");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");
const { MESSAGE_MAX_LENGTH } = require("./shared");

const { message } = schema;
const { and, eq, isNull, sql } = ops;

// Editing a TEXT message. Own messages only, no time limit — same posture as
// delete-for-everyone.
function registerEditHandler(io, socket) {
  const userId = socket.data.user.id;

  socket.on("message:edit", async (payload, ack) => {
    try {
      const messageId = payload && payload.messageId;
      if (typeof messageId !== "string" || !ID_PATTERN.test(messageId)) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
      if (!payload || typeof payload.text !== "string") {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
      const body = payload.text.trim();
      if (body.length === 0) return fail(ack, { code: "INVALID", error: "Type a message." });
      if (body.length > MESSAGE_MAX_LENGTH) {
        return fail(ack, { code: "TOO_LONG", error: `Messages can be up to ${MESSAGE_MAX_LENGTH} characters.` });
      }
      if (!allow(`edit:${userId}`, LIMITS.edit.windowMs, LIMITS.edit.max)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }

      // TEXT only and not already a tombstone, both in the WHERE so the whole
      // authorization decision is one statement. createdAt is untouched, so
      // ordering never shifts under an edit.
      //
      // conversation.updatedAt is deliberately NOT bumped: an edit to a
      // week-old message must not jump that conversation to the top of
      // everybody's sidebar.
      const updated = await db
        .update(message)
        .set({ body, editedAt: sql`now()` })
        .where(
          and(
            eq(message.id, messageId),
            eq(message.senderId, userId),
            eq(message.type, "TEXT"),
            isNull(message.deletedAt),
          ),
        )
        .returning({
          conversationId: message.conversationId,
          body: message.body,
          editedAt: message.editedAt,
        });

      if (updated.length === 0) return fail(ack, { code: "NOT_FOUND", error: "Message not found." });

      const row = updated[0];
      const editedAt = row.editedAt ? row.editedAt.toISOString() : new Date().toISOString();
      notify.toConversation(io, row.conversationId, "message:edited", {
        conversationId: row.conversationId,
        messageId,
        body: row.body,
        editedAt,
      });
      if (typeof ack === "function") {
        ack({ ok: true, messageId, conversationId: row.conversationId, body: row.body, editedAt });
      }
    } catch (error) {
      console.error("[chat:message-edit]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't save that edit. Try again." });
    }
  });
}

module.exports = { registerEditHandler };
