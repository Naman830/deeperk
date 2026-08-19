const presence = require("../presence");
const { joinInitialRooms } = require("../rooms");
const { registerChatHandlers } = require("../handlers/chat");
const { registerCallHandlers } = require("../handlers/call");
const notify = require("../handlers/notify");

function registerConnectionHandlers(io, bootId) {
  io.on("connection", async (socket) => {
    const userId = socket.data.user.id;

    // Listeners FIRST, before any awaited work. Socket.IO silently drops an
    // event that arrives with no listener, and a client — or its reconnect
    // buffer, which flushes the instant the transport opens — may emit as soon
    // as it sees session:ready. Registering after the presence round trips
    // left a window a whole Neon query wide where a send was lost with no ack,
    // no error, no log (found by the e2e harness, 2026-08-18).
    registerChatHandlers(io, socket);
    // Same rule. Also load-bearing: call.js's own disconnecting listener must
    // register before this file's, so its last-tab check reads presence before
    // remove() runs below.
    registerCallHandlers(io, socket);

    // Presence counts this socket from the same synchronous tick as the
    // listeners. Added after the awaits below, a socket that died mid-await
    // would (a) make call.js's last-tab check miscount and kill live rings,
    // and (b) be added AFTER its own "disconnecting" already ran — a dead
    // socket counted forever, disabling grace expiry for this user.
    const isFirstTab = presence.add(userId, socket.id);

    // "disconnecting", not "disconnect": by the time disconnect fires
    // socket.rooms is already cleared, so there is nothing left to broadcast to.
    // This presents as "offline events randomly don't work". Registered in the
    // synchronous prefix for the same reason presence.add is.
    socket.on("disconnecting", async () => {
      const rooms = [...socket.rooms].filter((room) =>
        room.startsWith("conversation:"),
      );
      const ids = rooms.map((room) => room.slice("conversation:".length));

      // A client that dies mid-keystroke otherwise leaves a permanent
      // "X is typing…" in everyone else's UI.
      for (const conversationId of ids) {
        notify.toConversationExceptSender(socket, conversationId, "typing:stop", {
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

    let conversationIds = [];
    try {
      conversationIds = await joinInitialRooms(socket);
    } catch (error) {
      console.error("[socket:join-rooms]", error);
    }

    // The client needs its own id to answer "is this bubble mine?" for room
    // broadcasts. Emitted here rather than widening search results with user ids.
    socket.emit("session:ready", { userId, bootId });

    // count() guard: if the socket died during the awaits above, its
    // disconnecting handler already ran — don't mark a dead session online.
    if (isFirstTab && presence.count(userId) > 0) {
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
  });
}

module.exports = { registerConnectionHandlers };
