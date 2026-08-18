const { Server } = require("socket.io");

const { env } = require("../env");
const { resolveHandshakeUser } = require("./auth");
const presence = require("../presence");

const MAX_SOCKETS_PER_USER = 10;

function createIo(httpServer) {
  const io = new Server(httpServer, {
    serveClient: false,
    cors: {
      // An explicit allowlist. Never "*" (the browser rejects it outright with
      // credentials), never a regex like /localhost/ (matches localhost.evil.com),
      // and never a reflected req.headers.origin — that one fails silently.
      origin: env.WEB_ORIGINS,
      credentials: true,
      methods: ["GET", "POST"],
    },
    // CORS only guards engine.io's HTTP polling handshake. A raw WebSocket
    // upgrade is not subject to CORS at all, so without this check any page could
    // open an authenticated socket as the visiting user and read their messages.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      // Non-browser clients (the verification harness) send no Origin.
      if (!origin) return callback(null, true);
      callback(null, env.WEB_ORIGINS.includes(origin));
    },
    // 4000 chars is ~16KB in UTF-8. The 1MB default multiplied by N sockets is a
    // memory vector, and exceeding the cap *closes the connection* rather than
    // raising an error the handler could turn into a message.
    maxHttpBufferSize: 100_000,
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // connectionStateRecovery is deliberately OFF: it restores rooms and replays
    // buffered packets WITHOUT re-running io.use(), so a session revoked inside
    // the window keeps receiving messages. GET /messages?after= already backfills
    // anything missed, without that hole.
  });

  io.use(async (socket, next) => {
    const result = await resolveHandshakeUser(socket.handshake);
    if (result.error) return next(result.error);

    // Each connection costs a get-session round trip plus a DB read; without a
    // cap one account can open thousands.
    if (presence.count(result.user.id) >= MAX_SOCKETS_PER_USER) {
      const error = new Error("Too many open connections");
      error.data = { code: "TOO_MANY_CONNECTIONS" };
      return next(error);
    }

    socket.data.user = result.user;
    next();
  });

  return io;
}

module.exports = { createIo };
