const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../../config/db");
const { requireMembership } = require("../../services/rooms");
const { allow, LIMITS } = require("../../services/rate-limit");
const { verifyMediaToken } = require("../../services/media-token");
const notify = require("../notify");
const { ID_PATTERN, fail, serializeMessage, sendIsBlocked } = require("../shared");
const { MESSAGE_MAX_LENGTH, NOT_FOUND, BLOCKED } = require("./shared");

const { conversation, message } = schema;
const { and, eq, isNull, sql } = ops;

const MAX_CLIENT_MSG_ID = 64;

// SYSTEM and CALL are missing on purpose. This reads like input validation and
// is actually an authorization control: without it any member can forge the
// bubble "Alice removed Bob from the group".
const SENDABLE_TYPES = new Set(["TEXT", "IMAGE", "VIDEO", "FILE"]);
const MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "FILE"]);

/**
 * A reply may only quote a live message in the SAME conversation.
 *
 * Not a nicety — without the conversation check, replyToId is a cross-
 * conversation content leak: the bubble renders the quoted snippet, so a
 * crafted id would surface text from a chat the sender was never in.
 */
async function replyTargetExists(replyToId, conversationId) {
  const rows = await db
    .select({ id: message.id })
    .from(message)
    .where(
      and(
        eq(message.id, replyToId),
        eq(message.conversationId, conversationId),
        isNull(message.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

function registerSendHandler(io, socket) {
  const userId = socket.data.user.id;

  socket.on("message:send", async (payload, ack) => {
    try {
      if (!payload || typeof payload !== "object") return fail(ack, { code: "INVALID", error: "Invalid request." });

      const { conversationId, clientMsgId, mediaToken } = payload;
      const type = payload.type || "TEXT";

      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
      if (typeof clientMsgId !== "string" || clientMsgId.length === 0 || clientMsgId.length > MAX_CLIENT_MSG_ID) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
      if (!SENDABLE_TYPES.has(type)) return fail(ack, { code: "INVALID", error: "Invalid request." });

      let body = null;
      let media = null;

      if (type === "TEXT") {
        if (typeof payload.text !== "string") return fail(ack, { code: "INVALID", error: "Invalid request." });
        body = payload.text.trim();
        if (body.length === 0) return fail(ack, { code: "INVALID", error: "Type a message." });
        if (body.length > MESSAGE_MAX_LENGTH) {
          return fail(ack, { code: "TOO_LONG", error: `Messages can be up to ${MESSAGE_MAX_LENGTH} characters.` });
        }
      } else if (MEDIA_TYPES.has(type)) {
        // Everything about the asset comes out of the signed token. The
        // client's own mediaUrl/mime/size/name are never read — see
        // services/media-token.js for why that matters.
        const claim = verifyMediaToken(mediaToken);
        if (!claim || claim.u !== userId || claim.c !== conversationId || claim.t !== type) {
          return fail(ack, { code: "INVALID", error: "That upload expired. Try attaching it again." });
        }
        media = claim;
      }

      // Rate limit BEFORE the membership query: it's the only check that costs
      // nothing, so it has to gate the ones that cost a round trip.
      if (!allow(`msg:${userId}`, LIMITS.message.windowMs, LIMITS.message.max)) {
        return fail(ack, { code: "RATE_LIMITED", error: "You're sending messages too quickly." });
      }

      // replyToId is validated below, in parallel with the two checks that were
      // already here. Shape first, so a malformed one never reaches the DB.
      const replyToId = payload.replyToId ?? null;
      if (replyToId !== null && (typeof replyToId !== "string" || !ID_PATTERN.test(replyToId))) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }

      // Three independent lookups, so they run concurrently rather than in
      // series. Never socket.rooms for the first one — room membership is
      // derived state maintained by a best-effort hook. Rooms decide delivery,
      // the database decides access.
      const [membership, blocked, replyOk] = await Promise.all([
        requireMembership(conversationId, userId),
        sendIsBlocked(conversationId, userId),
        replyToId === null ? Promise.resolve(true) : replyTargetExists(replyToId, conversationId),
      ]);
      if (!membership) return fail(ack, NOT_FOUND);
      if (blocked) return fail(ack, BLOCKED);
      // A vanished or cross-conversation quote drops the quote and keeps the
      // message, rather than failing the send: the text the user typed is the
      // thing they care about, and the alternative is losing it to a race with
      // the other person deleting the message being replied to.
      const safeReplyToId = replyOk ? replyToId : null;

      const id = randomUUID();
      const [inserted] = await db.batch([
        db
          .insert(message)
          .values({
            id,
            conversationId,
            senderId: userId,
            type,
            body,
            mediaUrl: media ? media.url : null,
            mediaPublicId: media ? media.p : null,
            mediaMime: media ? media.mime : null,
            mediaSize: media ? media.size : null,
            mediaName: media ? media.name : null,
            mediaWidth: media && media.w ? media.w : null,
            mediaHeight: media && media.h ? media.h : null,
            clientMsgId,
            replyToId: safeReplyToId,
          })
          // The retry half of chat.md §8. socket.io buffers emits while
          // disconnected and flushes on reconnect, so a send marked failed at
          // 10s and retried at 12s can have the original land at 15s. The
          // client reusing its clientMsgId is necessary; this is what makes it
          // sufficient. `where` reproduces the partial index's predicate so
          // Postgres can infer it.
          .onConflictDoNothing({
            target: [message.senderId, message.clientMsgId],
            where: sql`${message.clientMsgId} is not null`,
          })
          .returning(),
        // conversation.updatedAt has no $onUpdate — set by hand, or the sidebar
        // silently never re-sorts. SQL now() because this is compared against
        // message.createdAt, which the database stamps, and both are written
        // from two different processes.
        db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, conversationId)),
      ]);

      if (inserted.length === 0) {
        // A duplicate retry. Ack success with the original and broadcast
        // nothing — the room already received it.
        const [existing] = await db
          .select()
          .from(message)
          .where(and(eq(message.senderId, userId), eq(message.clientMsgId, clientMsgId)))
          .limit(1);
        if (typeof ack === "function" && existing) {
          ack({ ok: true, clientMsgId, message: serializeMessage(existing) });
        }
        return;
      }

      const saved = serializeMessage(inserted[0]);
      // To the whole room *including* the sender, so their other tabs see it.
      // Excluding the sender's socket and acking privately would silently break
      // multi-tab, which is a much worse bug than one redundant frame.
      notify.toConversation(io, conversationId, "message:new", { conversationId, message: saved });
      if (typeof ack === "function") ack({ ok: true, clientMsgId, message: saved });
    } catch (error) {
      console.error("[chat:message-send]", error);
      // Ack on every path, including this one — an unacked emit leaves the
      // optimistic bubble spinning forever, which is the silent message loss
      // chat.md §8 exists to prevent.
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't send that. Try again." });
    }
  });
}

module.exports = { registerSendHandler };
