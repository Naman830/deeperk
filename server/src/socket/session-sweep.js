const { resolveHandshakeUser } = require("./auth");
const { userRoom } = require("../rooms");
const presence = require("../presence");

const SESSION_RECHECK_MS = 5 * 60 * 1000;

/**
 * Sessions are checked once, at connect, and the socket stays trusted for the
 * life of the TCP connection — so signing out, resetting a password
 * (revokeSessionsOnPasswordReset) or changing an email (revokeOtherSessions)
 * would otherwise leave a live socket happily sending and receiving. One sweep
 * per distinct connected user, not per socket.
 *
 * Returns the (already unref'd) interval so shutdown can clearInterval it.
 */
function startSessionSweep(io) {
  const interval = setInterval(async () => {
    for (const userId of presence.onlineUserIds()) {
      const sockets = await io.in(userRoom(userId)).fetchSockets();
      const probe = sockets[0];
      if (!probe) continue;
      const result = await resolveHandshakeUser(probe.handshake).catch(() => ({
        error: true,
      }));
      if (result.error) {
        console.log(
          `[socket] session no longer valid for ${userId} — disconnecting`,
        );
        io.in(userRoom(userId)).disconnectSockets(true);
      }
    }
  }, SESSION_RECHECK_MS);
  interval.unref();
  return interval;
}

module.exports = { startSessionSweep };
