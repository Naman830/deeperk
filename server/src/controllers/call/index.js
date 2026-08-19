const activeCalls = require("../../services/active-calls");
const { registerInviteHandler } = require("./invite");
const { registerJoinHandlers } = require("./join");
const { registerControlHandlers } = require("./controls");
const { registerSignalHandlers } = require("./signal");
const { registerStateHandler } = require("./state");
const { registerDisconnectHandler } = require("./disconnect");
const { kickFromConversationCall } = require("./kick");

// The call controller. Everything registers synchronously — the disconnecting
// listener in particular must attach before socket/connection.js's own (its
// last-tab check reads presence before remove() runs there).
function registerCallHandlers(io, socket) {
  // FIRST: any new socket for this user cancels their disconnect grace — a
  // reconnect must never let the timer stamp them out of a call they rejoined.
  activeCalls.clearUserGraceTimers(socket.data.user.id);

  registerInviteHandler(io, socket);
  registerJoinHandlers(io, socket);
  registerControlHandlers(io, socket);
  registerSignalHandlers(io, socket);
  registerStateHandler(io, socket);
  registerDisconnectHandler(io, socket);
}

module.exports = { registerCallHandlers, kickFromConversationCall };
