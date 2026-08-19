const { requireMembership, conversationRoom } = require("../../services/rooms");
const { allow, LIMITS } = require("../../services/rate-limit");
const notify = require("../notify");
const { ID_PATTERN } = require("../shared");

function registerTypingHandlers(io, socket) {
  const userId = socket.data.user.id;

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

module.exports = { registerTypingHandlers };
