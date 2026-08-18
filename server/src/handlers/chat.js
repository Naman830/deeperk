const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../db");
const { requireMembership, conversationRoom } = require("../rooms");
const { allow, LIMITS } = require("../rate-limit");
const { verifyMediaToken } = require("../media-token");
const notify = require("./notify");

const { conversation, conversationMember, message } = schema;
const { and, eq, sql } = ops;

const MESSAGE_MAX_LENGTH = 4000;
const MAX_CLIENT_MSG_ID = 64;
const ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

// SYSTEM and CALL are missing on purpose. This reads like input validation and
// is actually an authorization control: without it any member can forge the
// bubble "Alice removed Bob from the group".
const SENDABLE_TYPES = new Set(["TEXT", "IMAGE", "VIDEO", "FILE"]);
const MEDIA_TYPES = new Set(["IMAGE", "VIDEO", "FILE"]);

// One answer for "no such conversation" and "you're not a member", so an id
// can never be probed for existence (chat.md §2.4).
const NOT_FOUND = { code: "NOT_FOUND", error: "Conversation not found." };

function fail(ack, payload) {
  if (typeof ack === "function") ack({ ok: false, ...payload });
}

function serialize(row) {
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
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

function registerChatHandlers(io, socket) {
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
        // media-token.js for why that matters.
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

      // Never socket.rooms — room membership is derived state maintained by a
      // best-effort hook. Rooms decide delivery, the database decides access.
      const membership = await requireMembership(conversationId, userId);
      if (!membership) return fail(ack, NOT_FOUND);

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
            clientMsgId,
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
          ack({ ok: true, clientMsgId, message: serialize(existing) });
        }
        return;
      }

      const saved = serialize(inserted[0]);
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

  socket.on("message:delete", async (payload, ack) => {
    try {
      const messageId = payload && payload.messageId;
      if (typeof messageId !== "string" || !ID_PATTERN.test(messageId)) {
        return fail(ack, { code: "INVALID", error: "Invalid request." });
      }
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
        })
        .where(and(eq(message.id, messageId), eq(message.senderId, userId)))
        .returning({ conversationId: message.conversationId, deletedAt: message.deletedAt });

      if (deleted.length === 0) return fail(ack, { code: "NOT_FOUND", error: "Message not found." });

      const row = deleted[0];
      const deletedAt = row.deletedAt ? row.deletedAt.toISOString() : new Date().toISOString();
      notify.toConversation(io, row.conversationId, "message:deleted", {
        conversationId: row.conversationId,
        messageId,
        deletedAt,
      });
      if (typeof ack === "function") ack({ ok: true, messageId, deletedAt });
    } catch (error) {
      console.error("[chat:message-delete]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't delete that. Try again." });
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
      // To this user's own tabs only, never the conversation room. chat.md §4
      // explicitly defers per-person read receipts, so broadcasting "X read at
      // T" would ship data for a feature the product doesn't display.
      socket.to(`user:${userId}`).emit("conversation:read-sync", { conversationId, lastReadAt });
      if (typeof ack === "function") ack({ ok: true, conversationId, lastReadAt });
    } catch (error) {
      console.error("[chat:conversation-read]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Something went wrong." });
    }
  });

  const relayTyping = (event) => async (payload) => {
    try {
      const conversationId = payload && payload.conversationId;
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) return;
      // Dropped silently rather than answered with an error — replying to every
      // rejected event just amplifies in the other direction.
      if (!allow(`typing:${userId}`, LIMITS.typing.windowMs, LIMITS.typing.max)) return;
      if (!socket.rooms.has(conversationRoom(conversationId))) return;

      const membership = await requireMembership(conversationId, userId);
      if (!membership) return;

      notify.toConversationExceptSender(socket, conversationId, event, {
        conversationId,
        userId,
        username: socket.data.user.username,
      });
    } catch (error) {
      console.error("[chat:typing]", error);
    }
  };

  socket.on("typing:start", relayTyping("typing:start"));
  socket.on("typing:stop", relayTyping("typing:stop"));
}

module.exports = { registerChatHandlers, serialize };
