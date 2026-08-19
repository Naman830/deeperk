const { randomUUID } = require("node:crypto");
const { db, schema, ops } = require("../db");
const { env } = require("../env");
const { requireMembership } = require("../rooms");
const { allow } = require("../rate-limit");
const presence = require("../presence");
const notify = require("./notify");
const activeCalls = require("../active-calls");

const { conversation, conversationMember, message, call, callParticipant, block, user } = schema;
const { and, eq, ne, or, sql, isNull, isNotNull, inArray } = ops;

const ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
// User ids are Better Auth's own 32-char base62, NOT this app's UUIDs — a
// UUID-shape check on rtc:signal's `to` rejects every real signal.
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CALL_KINDS = new Set(["AUDIO", "VIDEO"]);
const MAX_JOINED = 4; // mesh cap (call.md)

const INVALID = { code: "INVALID", error: "Invalid request." };
// One answer for "no such call" and "not yours to touch" — same probing rule
// as chat.js's NOT_FOUND. Terminal calls are removed from memory, so a late
// accept/reject lands here too.
const NOT_FOUND = { code: "NOT_FOUND", error: "Call not found." };
const CONVERSATION_NOT_FOUND = { code: "NOT_FOUND", error: "Conversation not found." };
// Byte-identical to CONVERSATION_NOT_FOUND on purpose: a differing string
// would let a caller distinguish "blocked" from "no such conversation".
const BLOCKED = { code: "NOT_FOUND", error: "Conversation not found." };

// 15 invites/hour. NOT rate-limit.js's allow() (frozen): its sweeper evicts
// buckets idle >5min, so an hour-long window would silently reset. This map
// is swept on window expiry only.
const INVITE_WINDOW_MS = 60 * 60_000;
const INVITE_MAX = 15;
const inviteBuckets = new Map(); // userId -> {windowStart, count}

function allowInvite(userId) {
  const now = Date.now();
  const bucket = inviteBuckets.get(userId);
  if (!bucket || now - bucket.windowStart >= INVITE_WINDOW_MS) {
    inviteBuckets.set(userId, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= INVITE_MAX;
}

const inviteSweeper = setInterval(() => {
  const cutoff = Date.now() - INVITE_WINDOW_MS;
  for (const [key, bucket] of inviteBuckets) {
    if (bucket.windowStart < cutoff) inviteBuckets.delete(key);
  }
}, 10 * 60_000);
inviteSweeper.unref();

function fail(ack, payload) {
  if (typeof ack === "function") ack({ ok: false, ...payload });
}

// CALL_ACTIVE carries the existing call so the client pivots to accept/join it.
function failCallActive(ack, record) {
  if (typeof ack === "function") {
    ack({
      ok: false,
      code: "CALL_ACTIVE",
      error: "A call is already active in this conversation.",
      callId: record.id,
      kind: record.kind,
    });
  }
}

// Private copy of chat.js's serialize() (frozen file). Three sites must stay
// identical — this, chat.js, and web's toChatMessage: the 17-field shape is
// pinned by tests/specs/00-contracts.spec.ts.
function serializeMessage(row) {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    body: row.body,
    mediaUrl: row.mediaUrl,
    mediaMime: row.mediaMime,
    mediaSize: row.mediaSize,
    mediaName: row.mediaName,
    mediaWidth: row.mediaWidth,
    mediaHeight: row.mediaHeight,
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt ? row.editedAt.toISOString() : null,
    deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
  };
}

// Duplicated from chat.js's sendIsBlocked (frozen file — merge the two copies
// when feature/message-reactions reintegrates). Both directions, DIRECT only,
// and needs nothing but (conversationId, userId) so it runs concurrently with
// the membership lookup.
async function callIsBlocked(conversationId, userId) {
  const rows = await db
    .select({ one: sql`1` })
    .from(conversationMember)
    .innerJoin(
      conversation,
      and(eq(conversation.id, conversationMember.conversationId), eq(conversation.type, "DIRECT")),
    )
    .innerJoin(
      block,
      or(
        and(eq(block.blockerId, userId), eq(block.blockedId, conversationMember.userId)),
        and(eq(block.blockerId, conversationMember.userId), eq(block.blockedId, userId)),
      ),
    )
    .where(and(eq(conversationMember.conversationId, conversationId), ne(conversationMember.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

// Conversation type/name + member display fields in one query — the CallUser
// enrichment source for ring payloads and acks. null when the conversation
// doesn't exist.
async function listMembers(conversationId) {
  const rows = await db
    .select({
      type: conversation.type,
      name: conversation.name,
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarPublicId: user.avatarPublicId,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .innerJoin(user, eq(user.id, conversationMember.userId))
    .where(eq(conversationMember.conversationId, conversationId));
  if (rows.length === 0) return null;
  return {
    type: rows[0].type,
    name: rows[0].name,
    members: rows.map(toCallUser),
  };
}

function toCallUser(m) {
  return {
    id: m.id,
    username: m.username,
    firstName: m.firstName,
    lastName: m.lastName,
    avatarPublicId: m.avatarPublicId,
  };
}

function endsWithoutUser(record, joinedRemaining) {
  // DIRECT ends below 2 joined; a lone GROUP participant keeps the call.
  return record.conversationType === "DIRECT" ? joinedRemaining < 2 : joinedRemaining === 0;
}

/**
 * The one finalizer. beginTerminal is a sync check-and-set BEFORE the first
 * await, so exactly one of the racing terminal paths (leave/cancel/timeout/
 * disconnect/kick) runs it.
 */
async function endCall(io, record, status) {
  if (!activeCalls.beginTerminal(record.id)) return;
  try {
    // Talk time, not ring time — and app clock on both sides (answeredAt is
    // Date.now() from markJoined), per the repo's clock-discipline rule.
    const durationSec =
      status === "ENDED" && record.answeredAt
        ? Math.round((Date.now() - record.answeredAt) / 1000)
        : null;
    // Ordered so each later statement's loss is strictly more cosmetic:
    // status flip > leftAt stamps > history bubble > sidebar re-sort.
    const results = await db.batch([
      db.update(call).set({ status, endedAt: sql`now()` }).where(eq(call.id, record.id)),
      db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(
          and(
            eq(callParticipant.callId, record.id),
            isNotNull(callParticipant.joinedAt),
            isNull(callParticipant.leftAt),
          ),
        ),
      db
        .insert(message)
        .values({
          id: randomUUID(),
          conversationId: record.conversationId,
          senderId: record.startedById,
          type: "CALL",
          callId: record.id,
          body: JSON.stringify({ status, kind: record.kind, durationSec }),
          clientMsgId: null,
        })
        .returning(),
      db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, record.conversationId)),
    ]);

    notify.toConversation(io, record.conversationId, "call:ended", {
      callId: record.id,
      conversationId: record.conversationId,
      status,
      endedAt: new Date().toISOString(),
    });
    const inserted = results[2];
    if (inserted && inserted[0]) {
      // Buys the whole chat.md §6 pipeline: previews, badges, toasts.
      notify.toConversation(io, record.conversationId, "message:new", {
        conversationId: record.conversationId,
        message: serializeMessage(inserted[0]),
      });
    }
  } catch (error) {
    console.error("[call:end]", error);
  } finally {
    // Always free the slot — a leaked byConversation entry permanently blocks
    // this conversation's calls.
    activeCalls.remove(record.id);
  }
}

/** Shared by call:accept and call:join — accept-while-ONGOING IS a join. */
async function joinCall(io, socket, payload, ack) {
  const userId = socket.data.user.id;
  try {
    const callId = payload && payload.callId;
    if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
    if (!allow(`callctl:${userId}`, 10_000, 20)) {
      return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
    }

    const record = activeCalls.get(callId);
    if (!record || record.terminal) return fail(ack, NOT_FOUND);
    // Cheap in-memory pre-checks before the DB round trip (re-checked after).
    const busyIn = activeCalls.callIdOf(userId);
    if (busyIn && busyIn !== callId) {
      return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
    }
    if (!activeCalls.isJoined(callId, userId) && activeCalls.joinedCount(callId) >= MAX_JOINED) {
      return fail(ack, { code: "CALL_FULL", error: "This call is full." });
    }

    // Fresh from the DB, never socket.rooms — same rule as chat.js.
    const [membership, info] = await Promise.all([
      requireMembership(record.conversationId, userId),
      listMembers(record.conversationId),
    ]);
    if (!membership || !info) return fail(ack, NOT_FOUND);

    // Re-check + markJoined with zero await between them: on Node's single
    // thread nothing can interleave, so the busy mark and the 4-slot cap are
    // reserved atomically.
    if (activeCalls.get(callId) !== record || record.terminal) return fail(ack, NOT_FOUND);
    const busyNow = activeCalls.callIdOf(userId);
    if (busyNow && busyNow !== callId) {
      return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
    }
    const alreadyJoined = activeCalls.isJoined(callId, userId);
    if (!alreadyJoined && activeCalls.joinedCount(callId) >= MAX_JOINED) {
      return fail(ack, { code: "CALL_FULL", error: "This call is full." });
    }
    const { becameOngoing } = activeCalls.markJoined(callId, userId);

    // COALESCE keeps the FIRST join time (the /calls duration derives from
    // it); leftAt cleared so a grace re-join un-leaves.
    const statements = [
      db
        .insert(callParticipant)
        .values({ callId, userId, joinedAt: sql`now()` })
        .onConflictDoUpdate({
          target: [callParticipant.callId, callParticipant.userId],
          set: { joinedAt: sql`COALESCE(${callParticipant.joinedAt}, now())`, leftAt: null },
        }),
    ];
    if (becameOngoing) {
      // Conditional so a late-landing batch can never resurrect a call a
      // racing terminal path already stamped ENDED/MISSED in the DB.
      statements.push(
        db.update(call).set({ status: "ONGOING" }).where(and(eq(call.id, callId), eq(call.status, "RINGING"))),
      );
    }
    try {
      await db.batch(statements);
    } catch (error) {
      // Roll back the FULL in-memory reservation, or the user is "busy"
      // forever and (worse) an ONGOING flip with a RINGING row breaks cancel.
      if (!alreadyJoined) activeCalls.markLeft(callId, userId);
      if (becameOngoing) activeCalls.revertOngoing(callId);
      throw error;
    }

    // A terminal path may have won while our batch was in flight; its leftAt
    // stamp ran before our upsert re-nulled it — restamp and bail.
    if (record.terminal || activeCalls.get(callId) !== record) {
      await db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(
          and(eq(callParticipant.callId, callId), eq(callParticipant.userId, userId), isNull(callParticipant.leftAt)),
        );
      return fail(ack, NOT_FOUND);
    }

    const joinedIds = activeCalls.joinedUserIds(callId);
    const byId = new Map(info.members.map((m) => [m.id, m]));
    const self = byId.get(userId);
    // Ack BEFORE the room broadcast: both ride the joiner's socket in order,
    // and the client must process its join result before its own echo of
    // call:participant-joined (or an accepting tab reads the echo as "another
    // tab answered" and tears itself down).
    if (typeof ack === "function") {
      ack({
        ok: true,
        callId,
        conversationId: record.conversationId,
        kind: record.kind,
        participants: joinedIds
          .filter((id) => id !== userId)
          .map((id) => byId.get(id))
          .filter(Boolean)
          .map(toCallUser),
        iceServers: env.ICE_SERVERS,
      });
    }
    // ALWAYS broadcast, re-joins included: this event is the §2.4 offer rule
    // and the reconnect re-peer mechanism — incumbents re-offer to this user.
    notify.toConversation(io, record.conversationId, "call:participant-joined", {
      callId,
      conversationId: record.conversationId,
      user: self ? toCallUser(self) : { id: userId, username: socket.data.user.username, firstName: null, lastName: null, avatarPublicId: null },
      joinedUserIds: joinedIds,
    });
  } catch (error) {
    console.error("[call:join]", error);
    fail(ack, { code: "SERVER_ERROR", error: "Couldn't join the call. Try again." });
  }
}

/**
 * Member removal (http/internal.js members.removed) force-leaves users from
 * the conversation's live call; a pending ring is dismissed on their own tabs.
 */
async function kickFromConversationCall(io, userIds, conversationId) {
  const record = activeCalls.getByConversation(conversationId);
  if (!record || record.terminal) return;

  const leftUserIds = [];
  let ends = false;
  for (const userId of userIds) {
    if (activeCalls.isJoined(record.id, userId)) {
      const { joinedRemaining } = activeCalls.markLeft(record.id, userId);
      leftUserIds.push(userId);
      if (endsWithoutUser(record, joinedRemaining)) ends = true;
    } else if (activeCalls.rungPendingUserIds(record.id).includes(userId)) {
      const { rungRemaining } = activeCalls.markRungGone(record.id, userId);
      notify.toUsers(io, [userId], "call:ring-cancelled", { callId: record.id, conversationId });
      if (record.status === "RINGING" && rungRemaining === 0) ends = true;
    }
  }

  if (ends) {
    const status = record.status === "RINGING" ? "MISSED" : "ENDED";
    await endCall(io, record, status);
    // endCall broadcasts to the conversation room, which the kicked users may
    // already have been removed from — tell them directly too.
    if (leftUserIds.length > 0) {
      notify.toUsers(io, leftUserIds, "call:ended", {
        callId: record.id,
        conversationId,
        status,
        endedAt: new Date().toISOString(),
      });
    }
    return;
  }
  if (leftUserIds.length === 0) return;
  await db
    .update(callParticipant)
    .set({ leftAt: sql`now()` })
    .where(and(eq(callParticipant.callId, record.id), inArray(callParticipant.userId, leftUserIds)));
  for (const userId of leftUserIds) {
    const payload = {
      callId: record.id,
      conversationId,
      userId,
      joinedUserIds: activeCalls.joinedUserIds(record.id),
    };
    notify.toConversation(io, conversationId, "call:participant-left", payload);
    // The kicked user's own tabs are likely out of the room already — their
    // force-leave teardown depends on this direct copy (duplicates are fine,
    // the client's handling is idempotent).
    notify.toUsers(io, [userId], "call:participant-left", payload);
  }
}

function startGraceTimer(io, record, userId) {
  const timer = setTimeout(() => {
    activeCalls.clearGraceTimer(record.id, userId);
    // Advisory timer — re-check everything against the state machine.
    if (activeCalls.get(record.id) !== record || record.terminal) return;
    if (!activeCalls.isJoined(record.id, userId)) return;
    if (presence.count(userId) > 0) return; // reconnected
    const { joinedRemaining } = activeCalls.markLeft(record.id, userId);
    if (endsWithoutUser(record, joinedRemaining)) {
      endCall(io, record, record.status === "RINGING" ? "MISSED" : "ENDED").catch((error) =>
        console.error("[call:grace-end]", error),
      );
      return;
    }
    db.update(callParticipant)
      .set({ leftAt: sql`now()` })
      .where(and(eq(callParticipant.callId, record.id), eq(callParticipant.userId, userId)))
      .then(() => {})
      .catch((error) => console.error("[call:grace-left]", error));
    notify.toConversation(io, record.conversationId, "call:participant-left", {
      callId: record.id,
      conversationId: record.conversationId,
      userId,
      joinedUserIds: activeCalls.joinedUserIds(record.id),
    });
  }, env.CALL_DISCONNECT_GRACE_MS);
  timer.unref();
  activeCalls.setGraceTimer(record.id, userId, timer);
}

function registerCallHandlers(io, socket) {
  const userId = socket.data.user.id;

  // FIRST: any new socket for this user cancels their disconnect grace — a
  // reconnect must never let the timer stamp them out of a call they rejoined.
  activeCalls.clearUserGraceTimers(userId);

  socket.on("call:invite", async (payload, ack) => {
    try {
      if (!payload || typeof payload !== "object") return fail(ack, INVALID);
      const { conversationId, kind } = payload;
      if (typeof conversationId !== "string" || !ID_PATTERN.test(conversationId)) return fail(ack, INVALID);
      if (!CALL_KINDS.has(kind)) return fail(ack, INVALID);

      if (!allowInvite(userId)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Too many calls in the last hour." });
      }
      // Re-invite cooldown: allows one immediate redial, blocks ring spam.
      if (!allow(`callconv:${userId}:${conversationId}`, 20_000, 2)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Give them a moment before calling again." });
      }

      // Cheap in-memory pre-checks before the DB round trips (re-checked after).
      if (activeCalls.callIdOf(userId)) {
        return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
      }
      const existing = activeCalls.getByConversation(conversationId);
      if (existing) return failCallActive(ack, existing);

      const [membership, info, blocked] = await Promise.all([
        requireMembership(conversationId, userId),
        listMembers(conversationId),
        callIsBlocked(conversationId, userId),
      ]);
      if (!membership || !info) return fail(ack, CONVERSATION_NOT_FOUND);
      // Masked as NOT_FOUND — reported to the caller as the offline case,
      // never "blocked".
      if (blocked) return fail(ack, BLOCKED);

      // From here to create() everything is synchronous: the re-checks and the
      // reservation cannot interleave with another handler, which is what
      // closes the two-invites-into-one-conversation race.
      if (activeCalls.callIdOf(userId)) {
        return fail(ack, { code: "SELF_BUSY", error: "You're already in a call." });
      }
      const raced = activeCalls.getByConversation(conversationId);
      if (raced) return failCallActive(ack, raced);

      // Online filter is live presence, not the laggy user.isOnline column.
      const rung = info.members.filter((m) => m.id !== userId && presence.count(m.id) > 0);
      if (rung.length === 0) {
        return fail(ack, {
          code: "OFFLINE",
          error: info.type === "DIRECT" ? "They're offline right now." : "Nobody is online right now.",
        });
      }
      if (info.type === "DIRECT" && rung.some((m) => activeCalls.callIdOf(m.id))) {
        return fail(ack, { code: "PEER_BUSY", error: "They're on another call." });
      }

      const callId = randomUUID();
      // Reservation BEFORE the insert (busy mark + the one-live-call-per-
      // conversation slot); rolled back on the failure path below.
      const record = activeCalls.create({
        id: callId,
        conversationId,
        conversationType: info.type,
        kind,
        startedById: userId,
        rungUserIds: rung.map((m) => m.id),
      });

      try {
        // Offline members get NO participant row.
        await db.batch([
          db.insert(call).values({ id: callId, conversationId, startedById: userId, kind, status: "RINGING" }),
          db.insert(callParticipant).values([
            { callId, userId, joinedAt: sql`now()` },
            ...rung.map((m) => ({ callId, userId: m.id, joinedAt: null })),
          ]),
        ]);
      } catch (error) {
        activeCalls.remove(callId);
        throw error;
      }

      // The caller's last socket can die while the insert is in flight: the
      // disconnect path ran endCall against rows that didn't exist yet (its
      // batch threw on the message FK), so the rows our batch just created are
      // orphans — stamp them terminal and neither ring nor arm the timer.
      if (record.terminal || activeCalls.get(callId) !== record) {
        await db.batch([
          db.update(call).set({ status: "MISSED", endedAt: sql`now()` }).where(eq(call.id, callId)),
          db
            .update(callParticipant)
            .set({ leftAt: sql`now()` })
            .where(
              and(eq(callParticipant.callId, callId), isNotNull(callParticipant.joinedAt), isNull(callParticipant.leftAt)),
            ),
        ]);
        return;
      }

      // Advisory timer; the state machine is the truth, so re-check first.
      const ringTimer = setTimeout(() => {
        activeCalls.clearRingTimer(callId);
        const live = activeCalls.get(callId);
        if (!live || live.terminal) return;
        if (live.status === "RINGING") {
          endCall(io, live, "MISSED").catch((error) => console.error("[call:ring-timeout]", error));
          return;
        }
        // Ring window closed but the call goes on — dismiss pending modals.
        notify.toUsers(io, activeCalls.rungPendingUserIds(callId), "call:ring-cancelled", {
          callId,
          conversationId,
        });
      }, env.CALL_RING_TIMEOUT_MS);
      ringTimer.unref();
      activeCalls.setRingTimer(callId, ringTimer);

      const caller = info.members.find((m) => m.id === userId);
      const startedAt = record.startedAt.toISOString();
      // Per rung member's user room, computed from the fresh SELECT — NEVER
      // the conversation room, whose Socket.IO membership can be stale.
      for (const m of rung) {
        notify.toUsers(io, [m.id], "call:ring", {
          callId,
          conversationId,
          conversationType: info.type,
          conversationName: info.name,
          kind,
          caller,
          startedAt,
          ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
        });
      }
      notify.toConversation(io, conversationId, "call:started", {
        callId,
        conversationId,
        kind,
        startedById: userId,
        startedAt,
      });
      if (typeof ack === "function") {
        ack({
          ok: true,
          callId,
          conversationId,
          kind,
          ringingUserIds: rung.map((m) => m.id),
          iceServers: env.ICE_SERVERS,
          ringTimeoutMs: env.CALL_RING_TIMEOUT_MS,
        });
      }
    } catch (error) {
      console.error("[call:invite]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't start the call. Try again." });
    }
  });

  socket.on("call:accept", (payload, ack) => joinCall(io, socket, payload, ack));
  socket.on("call:join", (payload, ack) => joinCall(io, socket, payload, ack));

  socket.on("call:cancel", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      // Caller + RINGING only; every other answer is the same NOT_FOUND.
      if (!record || record.terminal || record.startedById !== userId || record.status !== "RINGING") {
        return fail(ack, NOT_FOUND);
      }
      await endCall(io, record, "MISSED");
      if (typeof ack === "function") ack({ ok: true, callId });
    } catch (error) {
      console.error("[call:cancel]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't cancel the call." });
    }
  });

  socket.on("call:reject", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      // Rung and un-joined only.
      if (!record || record.terminal || !activeCalls.rungPendingUserIds(callId).includes(userId)) {
        return fail(ack, NOT_FOUND);
      }
      const { rungRemaining } = activeCalls.markRejected(callId, userId);
      if (record.conversationType === "DIRECT") {
        await endCall(io, record, "REJECTED");
      } else {
        // The rejecter's own other tabs dismiss their ring; the room learns
        // nothing — declining a group call is not a broadcastable act.
        socket.to(`user:${userId}`).emit("call:ring-handled", { callId, action: "REJECTED" });
        if (record.status === "RINGING" && rungRemaining === 0) {
          // Group ring-outs are always MISSED, even when everyone declined.
          await endCall(io, record, "MISSED");
        }
      }
      if (typeof ack === "function") ack({ ok: true, callId });
    } catch (error) {
      console.error("[call:reject]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't decline the call." });
    }
  });

  socket.on("call:leave", async (payload, ack) => {
    try {
      const callId = payload && payload.callId;
      if (typeof callId !== "string" || !ID_PATTERN.test(callId)) return fail(ack, INVALID);
      if (!allow(`callctl:${userId}`, 10_000, 20)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const record = activeCalls.get(callId);
      if (!record || record.terminal || !activeCalls.isJoined(callId, userId)) {
        return fail(ack, NOT_FOUND);
      }
      const { joinedRemaining } = activeCalls.markLeft(callId, userId);
      if (endsWithoutUser(record, joinedRemaining)) {
        // The caller leaving an unanswered call is a cancel in all but name.
        await endCall(io, record, record.status === "RINGING" ? "MISSED" : "ENDED");
        if (typeof ack === "function") ack({ ok: true, callId, ended: true });
        return;
      }
      await db
        .update(callParticipant)
        .set({ leftAt: sql`now()` })
        .where(and(eq(callParticipant.callId, callId), eq(callParticipant.userId, userId)));
      notify.toConversation(io, record.conversationId, "call:participant-left", {
        callId,
        conversationId: record.conversationId,
        userId,
        joinedUserIds: activeCalls.joinedUserIds(callId),
      });
      if (typeof ack === "function") ack({ ok: true, callId, ended: false });
    } catch (error) {
      console.error("[call:leave]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't leave the call." });
    }
  });

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

  // Resync after connect/reconnect: the user's own live call plus every live
  // call in a conversation they belong to (join banners).
  socket.on("call:state", async (payload, ack) => {
    try {
      if (!allow(`callstate:${userId}`, 10_000, 30)) {
        return fail(ack, { code: "RATE_LIMITED", error: "Slow down." });
      }
      const live = activeCalls.liveCalls().filter((record) => !record.terminal);

      // One membership query over the small live-call set — this is also the
      // fresh-from-DB authz for everything the ack reveals, self included.
      let memberOf = new Set();
      if (live.length > 0) {
        const rows = await db
          .select({ conversationId: conversationMember.conversationId })
          .from(conversationMember)
          .where(
            and(
              eq(conversationMember.userId, userId),
              inArray(conversationMember.conversationId, live.map((record) => record.conversationId)),
            ),
          );
        memberOf = new Set(rows.map((row) => row.conversationId));
      }
      const mine = live.filter((record) => memberOf.has(record.conversationId));
      const ongoing = mine.map((record) => ({
        callId: record.id,
        conversationId: record.conversationId,
        kind: record.kind,
        participantCount: activeCalls.joinedCount(record.id),
      }));

      const selfCallId = activeCalls.callIdOf(userId);
      const selfRecord = selfCallId ? mine.find((record) => record.id === selfCallId) : null;
      let self = null;
      if (selfRecord) {
        const info = await listMembers(selfRecord.conversationId);
        const byId = new Map((info ? info.members : []).map((m) => [m.id, m]));
        self = {
          callId: selfRecord.id,
          conversationId: selfRecord.conversationId,
          kind: selfRecord.kind,
          status: selfRecord.status,
          // Excluding self, same convention as the accept/join ack — the
          // client renders participants as remote tiles.
          participants: activeCalls
            .joinedUserIds(selfRecord.id)
            .filter((id) => id !== userId)
            .map((id) => byId.get(id))
            .filter(Boolean)
            .map(toCallUser),
          iceServers: env.ICE_SERVERS,
        };
      }
      if (typeof ack === "function") ack({ ok: true, self, ongoing });
    } catch (error) {
      console.error("[call:state]", error);
      fail(ack, { code: "SERVER_ERROR", error: "Couldn't sync call state." });
    }
  });

  // Registered BEFORE connection.js's disconnecting listener (registration
  // order = firing order), so presence still counts THIS socket:
  // count <= 1 means this was the user's last tab. Load-bearing ordering.
  socket.on("disconnecting", () => {
    try {
      if (presence.count(userId) > 1) return; // another tab still signals

      const callId = activeCalls.callIdOf(userId);
      const record = callId ? activeCalls.get(callId) : null;
      if (record && !record.terminal) {
        if (record.status === "RINGING" && record.startedById === userId) {
          // The ringing caller's last socket died: nobody left to answer to.
          endCall(io, record, "MISSED").catch((error) => console.error("[call:disconnect-end]", error));
        } else {
          // P2P media outlives the signaling socket — grace, not an instant
          // leave. Any new socket for this user clears it (register, line 1).
          startGraceTimer(io, record, userId);
        }
      }

      // Rung but not joined: a DIRECT ring dies with the callee (§2.3), a
      // group callee just falls out of the rung set.
      for (const ringing of activeCalls.ringsFor(userId)) {
        if (ringing.conversationType === "DIRECT") {
          endCall(io, ringing, "MISSED").catch((error) => console.error("[call:disconnect-missed]", error));
        } else {
          const { rungRemaining } = activeCalls.markRungGone(ringing.id, userId);
          if (ringing.status === "RINGING" && rungRemaining === 0) {
            endCall(io, ringing, "MISSED").catch((error) => console.error("[call:disconnect-missed]", error));
          }
        }
      }
    } catch (error) {
      console.error("[call:disconnecting]", error);
    }
  });
}

module.exports = { registerCallHandlers, kickFromConversationCall };
