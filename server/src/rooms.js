const { db, schema, ops } = require("./db");

const { conversationMember } = schema;
const { and, eq } = ops;

/**
 * Room naming and membership.
 *
 * The rule that matters: **rooms are only ever joined from a server-side
 * SELECT.** There is no client-emitted join event anywhere in this server, and
 * adding one would hand every user the ability to listen to any conversation.
 *
 * Rooms decide *delivery*. The database decides *authorization* — see
 * requireMembership, which every handler calls even though the socket is
 * already in the room. A user removed from a group stays in the Socket.IO room
 * until something explicitly removes them, and if that removal happened in the
 * Next process this server may not have heard about it yet.
 */

const userRoom = (userId) => `user:${userId}`;
const conversationRoom = (conversationId) => `conversation:${conversationId}`;

async function listConversationIds(userId) {
  const rows = await db
    .select({ conversationId: conversationMember.conversationId })
    .from(conversationMember)
    .where(eq(conversationMember.userId, userId));
  return rows.map((row) => row.conversationId);
}

async function joinInitialRooms(socket) {
  const userId = socket.data.user.id;
  socket.join(userRoom(userId));
  const ids = await listConversationIds(userId);
  for (const id of ids) socket.join(conversationRoom(id));
  return ids;
}

/**
 * The single most important check in this whole feature (chat.md §2.4).
 *
 * Returns null for "no such conversation" AND "you're not a member" — callers
 * send the identical NOT_FOUND for both, so a conversation id can never be
 * probed for existence.
 *
 * Not cached. A stale cache would let a just-removed member keep posting for
 * the cache's lifetime, which is precisely what this check exists to prevent;
 * a composite-PK lookup is cheap enough to pay every time.
 */
async function requireMembership(conversationId, userId) {
  const rows = await db
    .select({ role: conversationMember.role })
    .from(conversationMember)
    .where(and(eq(conversationMember.conversationId, conversationId), eq(conversationMember.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Someone was added to a group while already connected — chat.md's §2.1
 *  diagram joins rooms once at connect and never revisits this. */
function joinUsersToConversation(io, userIds, conversationId) {
  for (const userId of userIds) {
    io.in(userRoom(userId)).socketsJoin(conversationRoom(conversationId));
  }
}

function removeUsersFromConversation(io, userIds, conversationId) {
  for (const userId of userIds) {
    io.in(userRoom(userId)).socketsLeave(conversationRoom(conversationId));
  }
}

module.exports = {
  userRoom,
  conversationRoom,
  listConversationIds,
  joinInitialRooms,
  requireMembership,
  joinUsersToConversation,
  removeUsersFromConversation,
};
