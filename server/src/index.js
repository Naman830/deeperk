// Realtime server for chat (Docs/chat/chat.md §3) and, later, call signaling
// (Docs/call/call.md §3 — one new handler file, no new process).
//
// Started with `node --env-file=.env`, so the environment is populated before
// any module loads. That ordering is load-bearing: db/index.js calls
// neon(process.env.DATABASE_URL) at module level.

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const { Server } = require("socket.io");

const { env } = require("./env");
const { resolveHandshakeUser } = require("./socket/auth");
const presence = require("./presence");
const { joinInitialRooms } = require("./rooms");
const { registerChatHandlers } = require("./handlers/chat");
const notify = require("./handlers/notify");
const { internalRouter } = require("./internal");

const BOOT_ID = randomUUID();
const MAX_SOCKETS_PER_USER = 10;
const SESSION_RECHECK_MS = 5 * 60 * 1000;

const app = express();
app.disable("x-powered-by");

// bootId lets the verification harness assert the process didn't restart
// mid-test — the in-memory rate limiters reset when it does, which otherwise
// makes limit assertions quietly non-deterministic under nodemon.
app.get("/healthz", (_req, res) =>
  res.json({ ok: true, bootId: BOOT_ID, uptime: process.uptime() }),
);

let io;
app.use(
  "/internal",
  express.json({ limit: "64kb" }),
  internalRouter(() => io),
);

// Socket.IO must attach to the http.Server, never app.listen() — that is the
// one line that silently produces "the client connects to nothing".
const httpServer = http.createServer(app);

io = new Server(httpServer, {
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
  socket.emit("session:ready", { userId, bootId: BOOT_ID });

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

/**
 * Sessions are checked once, at connect, and the socket stays trusted for the
 * life of the TCP connection — so signing out, resetting a password
 * (revokeSessionsOnPasswordReset) or changing an email (revokeOtherSessions)
 * would otherwise leave a live socket happily sending and receiving. One sweep
 * per distinct connected user, not per socket.
 */
const revalidation = setInterval(async () => {
  for (const userId of presence.onlineUserIds()) {
    const sockets = await io.in(`user:${userId}`).fetchSockets();
    const probe = sockets[0];
    if (!probe) continue;
    const result = await resolveHandshakeUser(probe.handshake).catch(() => ({
      error: true,
    }));
    if (result.error) {
      console.log(
        `[socket] session no longer valid for ${userId} — disconnecting`,
      );
      io.in(`user:${userId}`).disconnectSockets(true);
    }
  }
}, SESSION_RECHECK_MS);
revalidation.unref();

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(revalidation);
  io.close();
  // Bounded: a hung database must not block a restart, and boot reconciliation
  // will clean up whatever this misses.
  await Promise.race([
    presence.flushAllOffline(),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).catch(() => {});
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown); // nodemon sends this on every restart
process.on("unhandledRejection", (error) =>
  console.error("[socket:unhandled-rejection]", error),
);

(async () => {
  try {
    // Before listening: the only thing that fixes rows left is_online = true by
    // a crash. Runs constantly in dev, where nodemon restarts on every save.
    await presence.reconcileOnBoot();
  } catch (error) {
    console.error("[socket:boot-reconcile]", error);
  }
  httpServer.listen(env.SOCKET_PORT, () => {
    console.log(`[socket] listening on :${env.SOCKET_PORT} (boot ${BOOT_ID})`);
    console.log(`[socket] allowed origins: ${env.WEB_ORIGINS.join(", ")}`);
  });
})();
