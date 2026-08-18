const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../db");
const { requireMembership, conversationRoom } = require("../rooms");
const { allow, LIMITS } = require("../rate-limit");
const { verifyMediaToken } = require("../media-token");
const presence = require("../presence");
const notify = require("./notify");

const { conversation, conversationMember, message, messageDeletion, block } = schema;
const { and, eq, inArray, isNull, ne, or, sql } = ops;

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
// Deliberately non-committal, and deliberately NOT "you are blocked". Telling
// someone they have been blocked is itself information the blocker did not
// agree to share, and it turns the block into a notification.
const BLOCKED = { code: "NOT_FOUND", error: "Couldn't send that message." };

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

/**
 * Is a send into this conversation blocked?
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
    mediaWidth: row.mediaWidth,
    mediaHeight: row.mediaHeight,
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
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

  // Editing a TEXT message. Own messages only, no time limit — same posture as
  // delete-for-everyone.
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

module.exports = { registerChatHandlers };
