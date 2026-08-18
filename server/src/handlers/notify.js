const { userRoom, conversationRoom } = require("../rooms");

/**
 * Fan-out primitives (Docs/chat/chat.md §3's notify.js).
 *
 * Note what this is NOT: there is no second delivery channel for notifications.
 * §6's gate — "are you looking at this conversation right now?" — is client
 * state the server cannot know, so `message:new` goes to the room and the
 * client decides badge / toast / sound / title.
 *
 * What lives here is the one place that decides *who receives what*, so
 * handlers/chat.js and the future handlers/call.js share it rather than each
 * naming rooms inline.
 *
 * Considered and rejected: a per-recipient `notify:message` carrying an
 * authoritative unread count. That is N COUNT(*) queries per message sent. The
 * client increments locally and reconciles against GET /api/conversations on
 * focus and on reconnect.
 */

function toConversation(io, conversationId, event, payload) {
  io.to(conversationRoom(conversationId)).emit(event, payload);
}

/** Excludes the emitting socket. Used for typing, which the sender doesn't need back. */
function toConversationExceptSender(socket, conversationId, event, payload) {
  socket.to(conversationRoom(conversationId)).emit(event, payload);
}

function toUser(io, userId, event, payload) {
  io.to(userRoom(userId)).emit(event, payload);
}

function toUsers(io, userIds, event, payload) {
  if (userIds.length === 0) return;
  io.to(userIds.map(userRoom)).emit(event, payload);
}

/**
 * Presence goes to the union of the subject's conversation rooms — never a
 * global broadcast, which would leak everyone's activity to everyone. Socket.IO
 * de-duplicates recipients across rooms, so this is one emit, not N.
 */
function presence(io, conversationIds, event, payload) {
  if (conversationIds.length === 0) return;
  io.to(conversationIds.map(conversationRoom)).emit(event, payload);
}

module.exports = { toConversation, toConversationExceptSender, toUser, toUsers, presence };
