const { allow } = require("../../services/rate-limit");
const activeCalls = require("../../services/active-calls");
const notify = require("../notify");
const { ID_PATTERN, fail } = require("../shared");
const { USER_ID_PATTERN, INVALID, NOT_FOUND } = require("./shared");

// The WebRTC signal relay plus the mute-state side channel.
function registerSignalHandlers(io, socket) {
  const userId = socket.data.user.id;

  socket.on("rtc:signal", (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      const to = payload && payload.to;
      if (
        typeof callId !== "string" ||
        !ID_PATTERN.test(callId) ||
        typeof to !== "string" ||
        !USER_ID_PATTERN.test(to) ||
        payload.data === undefined
      ) {
        return fail(ack, INVALID);
      }
      // BOTH ends must be joined participants — the `to` check is what stops
      // this relay being a message-anyone primitive. Ended/unknown calls drop
      // silently (fail() no-ops without an ack). data is opaque, never read.
      const record = activeCalls.get(callId);
      if (!record || record.terminal || !activeCalls.isJoined(callId, userId) || !activeCalls.isJoined(callId, to)) {
        return fail(ack, NOT_FOUND);
      }
      notify.toUsers(io, [to], "rtc:signal", { callId, from: userId, data: payload.data });
      if (typeof ack === "function") ack({ ok: true });
    } catch (error) {
      console.error("[call:rtc-signal]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Signal failed." });
    }
  });

  // Fire-and-forget: no ack, silent drop on every failure.
  socket.on("call:mute-state", (payload) => {
    try {
      if (!payload || typeof payload !== "object") return;
      const { callId, micMuted, cameraOff } = payload;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return;
      if (typeof micMuted !== "boolean" || typeof cameraOff !== "boolean") return;
      if (!allow(`callmute:${userId}`, 10_000, 20)) return;
      if (!activeCalls.isJoined(callId, userId)) return;
      notify.toUsers(
        io,
        activeCalls.joinedUserIds(callId).filter((id) => id !== userId),
        "call:mute-state",
        { callId, userId, micMuted, cameraOff },
      );
    } catch (error) {
      console.error("[call:mute-state]", error);
    }
  });
}

module.exports = { registerSignalHandlers };
