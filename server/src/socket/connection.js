const presence = require("../presence");
const { joinInitialRooms } = require("../rooms");
const { registerChatHandlers } = require("../handlers/chat");
const notify = require("../handlers/notify");

function registerConnectionHandlers(io, bootId) {
  io.on("connection", async (socket) => {
    const userId = socket.data.user.id;

    let conversationIds = [];
    try {
      conversationIds = await joinInitialRooms(socket);
    } catch (error) {
      console.error("[socket:join-rooms]", error);
    }

    // The client needs its own id to answer "is this bubble mine?" for room
    // broadcasts. Emitted here rather than widening search results with user ids.
    socket.emit("session:ready", { userId, bootId });

    const isFirstTab = presence.add(userId, socket.id);
    if (isFirstTab) {
      try {
        await presence.markOnline(userId);
        if (await presence.readsPresencePublicly(userId)) {
          notify.presence(io, conversationIds, "presence:online", {
            userId,
            at: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error("[socket:presence-online]", error);
      }
    }

    registerChatHandlers(io, socket);

    // "disconnecting", not "disconnect": by the time disconnect fires
    // socket.rooms is already cleared, so there is nothing left to broadcast to.
    // This presents as "offline events randomly don't work".
    socket.on("disconnecting", async () => {
      const rooms = [...socket.rooms].filter((room) =>
        room.startsWith("conversation:"),
      );
      const ids = rooms.map((room) => room.slice("conversation:".length));

      // A client that dies mid-keystroke otherwise leaves a permanent
      // "X is typing…" in everyone else's UI.
      for (const conversationId of ids) {
        socket.to(`conversation:${conversationId}`).emit("typing:stop", {
          conversationId,
          userId,
          username: socket.data.user.username,
        });
      }

      if (!presence.remove(userId, socket.id)) return;
      try {
        await presence.markOffline(userId);
        if (await presence.readsPresencePublicly(userId)) {
          notify.presence(io, ids, "presence:offline", {
            userId,
            lastSeenAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        console.error("[socket:presence-offline]", error);
      }
    });
  });
}

module.exports = { registerConnectionHandlers };
