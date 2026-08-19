const { db, schema, ops } = require("./db");
const { env } = require("./env");

const { call, callParticipant } = schema;
const { and, eq, isNull, isNotNull, sql } = ops;

/**
 * Live-call state machine (Docs/call/call.md).
 *
 * Every transition here is SYNCHRONOUS — zero await between check and mutate —
 * so handlers can check-and-reserve atomically on Node's single thread. DB
 * writes happen in handlers/call.js afterwards, driven by the returned result.
 * Timers are advisory; this state is the truth, and every timer callback
 * re-checks it before acting.
 *
 * Single-server assumption, same as presence.js and the rest of the in-memory
 * state here.
 */
const calls = new Map(); // callId -> CallRecord
const byUser = new Map(); // userId -> callId (JOINED users only — rung is not busy)
const byConversation = new Map(); // conversationId -> callId (one live call per conversation)

/**
 * CallRecord:
 *   {id, conversationId, conversationType, kind, status: "RINGING"|"ONGOING",
 *    startedById, startedAt: Date, answeredAt: ms|null, terminal, ringTimer,
 *    participants: Map<userId, {rung, joinedAt: Date|null, left, rejected, graceTimer}>}
 */
function create({ id, conversationId, conversationType, kind, startedById, rungUserIds }) {
  const participants = new Map([
    [startedById, { rung: false, joinedAt: new Date(), left: false, rejected: false, graceTimer: null }],
  ]);
  for (const userId of rungUserIds) {
    participants.set(userId, { rung: true, joinedAt: null, left: false, rejected: false, graceTimer: null });
  }
  const record = {
    id,
    conversationId,
    conversationType,
    kind,
    status: "RINGING",
    startedById,
    startedAt: new Date(),
    answeredAt: null,
    terminal: false,
    ringTimer: null,
    participants,
  };
  calls.set(id, record);
  byConversation.set(conversationId, id);
  byUser.set(startedById, id);
  return record;
}

function get(callId) {
  return calls.get(callId);
}

function getByConversation(conversationId) {
  const callId = byConversation.get(conversationId);
  return callId ? calls.get(callId) : undefined;
}

/** The call this user is JOINED in, if any — the "busy" check. */
function callIdOf(userId) {
  return byUser.get(userId);
}

function isJoined(callId, userId) {
  const record = calls.get(callId);
  const entry = record && record.participants.get(userId);
  return Boolean(entry && entry.joinedAt && !entry.left);
}

function joinedUserIds(callId) {
  const record = calls.get(callId);
  if (!record) return [];
  const ids = [];
  for (const [userId, entry] of record.participants) {
    if (entry.joinedAt && !entry.left) ids.push(userId);
  }
  return ids;
}

function joinedCount(callId) {
  return joinedUserIds(callId).length;
}

/** All live records — call:state's ongoing list filters these by membership. */
function liveCalls() {
  return [...calls.values()];
}

/** Live calls where this user is rung and pending — the disconnect matrix needs it. */
function ringsFor(userId) {
  const found = [];
  for (const record of calls.values()) {
    if (record.terminal) continue;
    const entry = record.participants.get(userId);
    if (entry && entry.rung && !entry.joinedAt && !entry.rejected && !entry.left) found.push(record);
  }
  return found;
}

function markJoined(callId, userId) {
  const record = calls.get(callId);
  if (!record) return null;
  let entry = record.participants.get(userId);
  if (entry && entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
  if (entry && entry.joinedAt && !entry.left) {
    return { alreadyJoined: true, becameOngoing: false };
  }
  if (!entry) {
    // A member who was never rung (offline at invite) may still join.
    entry = { rung: false, joinedAt: null, left: false, rejected: false, graceTimer: null };
    record.participants.set(userId, entry);
  }
  entry.joinedAt = entry.joinedAt ?? new Date(); // keep the FIRST join time
  entry.left = false;
  entry.rejected = false;
  byUser.set(userId, callId);
  let becameOngoing = false;
  if (record.status === "RINGING") {
    record.status = "ONGOING";
    // App clock, matched against Date.now() at finalize for durationSec.
    record.answeredAt = Date.now();
    becameOngoing = true;
  }
  return { alreadyJoined: false, becameOngoing };
}

/**
 * Rollback for a first join whose DB write failed: the RINGING→ONGOING flip
 * must not survive, or the ring timer can never MISS the call and the caller's
 * cancel (RINGING-only) is refused — a permanently stuck conversation slot.
 */
function revertOngoing(callId) {
  const record = calls.get(callId);
  if (record && !record.terminal && record.status === "ONGOING") {
    record.status = "RINGING";
    record.answeredAt = null;
  }
}

function markRejected(callId, userId) {
  const record = calls.get(callId);
  if (!record) return null;
  const entry = record.participants.get(userId);
  if (entry) entry.rejected = true;
  return { rungRemaining: rungPendingUserIds(callId).length };
}

/** A rung callee's last socket died — they fall out of the rung set. */
function markRungGone(callId, userId) {
  const record = calls.get(callId);
  if (!record) return null;
  const entry = record.participants.get(userId);
  if (entry) entry.rung = false;
  return { rungRemaining: rungPendingUserIds(callId).length };
}

function markLeft(callId, userId) {
  const record = calls.get(callId);
  if (!record) return null;
  const entry = record.participants.get(userId);
  if (entry) {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    entry.left = true;
  }
  if (byUser.get(userId) === callId) byUser.delete(userId);
  return { joinedRemaining: joinedCount(callId) };
}

function rungPendingUserIds(callId) {
  const record = calls.get(callId);
  if (!record) return [];
  const ids = [];
  for (const [userId, entry] of record.participants) {
    if (entry.rung && !entry.joinedAt && !entry.rejected && !entry.left) ids.push(userId);
  }
  return ids;
}

function setRingTimer(callId, timer) {
  const record = calls.get(callId);
  if (record) record.ringTimer = timer;
}

function clearRingTimer(callId) {
  const record = calls.get(callId);
  if (record && record.ringTimer) {
    clearTimeout(record.ringTimer);
    record.ringTimer = null;
  }
}

function setGraceTimer(callId, userId, timer) {
  const record = calls.get(callId);
  const entry = record && record.participants.get(userId);
  if (!entry) return;
  if (entry.graceTimer) clearTimeout(entry.graceTimer);
  entry.graceTimer = timer;
}

function clearGraceTimer(callId, userId) {
  const record = calls.get(callId);
  const entry = record && record.participants.get(userId);
  if (entry && entry.graceTimer) {
    clearTimeout(entry.graceTimer);
    entry.graceTimer = null;
  }
}

/** Any new socket for a user cancels their disconnect grace, in every call. */
function clearUserGraceTimers(userId) {
  for (const record of calls.values()) {
    const entry = record.participants.get(userId);
    if (entry && entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
  }
}

/**
 * Sync check-and-set: the first caller wins, so exactly one finalizer runs no
 * matter how many terminal paths (leave/cancel/timeout/disconnect) race.
 */
function beginTerminal(callId) {
  const record = calls.get(callId);
  if (!record || record.terminal) return false;
  record.terminal = true;
  return true;
}

/** Clears ALL timers and all three maps — a leaked byConversation entry would
 *  permanently block that conversation's calls. */
function remove(callId) {
  const record = calls.get(callId);
  if (!record) return;
  if (record.ringTimer) {
    clearTimeout(record.ringTimer);
    record.ringTimer = null;
  }
  for (const [userId, entry] of record.participants) {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
    if (byUser.get(userId) === callId) byUser.delete(userId);
  }
  if (byConversation.get(record.conversationId) === callId) byConversation.delete(record.conversationId);
  calls.delete(callId);
}

// Defensive sweeper — a bug detector, not correctness. Nothing legitimate
// leaves a call RINGING past the ring timer; if one turns up, log it loudly,
// finalize it in the DB (no history bubble — same rule as the boot sweep) and
// free the conversation slot. Clients resync via call:state.
const STUCK_RINGING_MS = 2 * 60_000;
const stuckSweeper = setInterval(() => {
  const cutoff = Date.now() - STUCK_RINGING_MS;
  for (const record of [...calls.values()]) {
    if (record.terminal || record.status !== "RINGING") continue;
    if (record.startedAt.getTime() >= cutoff) continue;
    console.error(`[call:sweep] call ${record.id} stuck RINGING > 2min — finalizing (ring timer bug?)`);
    remove(record.id);
    db.update(call)
      .set({ status: "MISSED", endedAt: sql`now()` })
      .where(eq(call.id, record.id))
      .then(() => {})
      .catch((error) => console.error("[call:sweep]", error));
  }
}, 60_000);
stuckSweeper.unref();

/**
 * Finalize calls left live by a crash, before accepting any connection.
 * Mirrors presence.reconcileOnBoot. Crash orphans get NO history bubble —
 * the sweep stays write-only-simple; the call row itself survives.
 */
async function reconcileOnBoot() {
  if (!env.SINGLE_INSTANCE) {
    console.warn("[socket] SOCKET_SINGLE_INSTANCE=false — skipping call reset.");
    return;
  }
  await db.batch([
    db.update(call).set({ status: "MISSED", endedAt: sql`now()` }).where(eq(call.status, "RINGING")),
    db.update(call).set({ status: "ENDED", endedAt: sql`now()` }).where(eq(call.status, "ONGOING")),
    // After the two sweeps every call is terminal, so no join is needed; the
    // joinedAt filter keeps rung-never-joined rows out of it.
    db
      .update(callParticipant)
      .set({ leftAt: sql`now()` })
      .where(and(isNull(callParticipant.leftAt), isNotNull(callParticipant.joinedAt))),
  ]);
}

function shutdown() {
  clearInterval(stuckSweeper);
  for (const record of calls.values()) {
    if (record.ringTimer) clearTimeout(record.ringTimer);
    for (const entry of record.participants.values()) {
      if (entry.graceTimer) clearTimeout(entry.graceTimer);
    }
  }
  calls.clear();
  byUser.clear();
  byConversation.clear();
}

module.exports = {
  create,
  get,
  getByConversation,
  callIdOf,
  isJoined,
  joinedUserIds,
  joinedCount,
  liveCalls,
  ringsFor,
  markJoined,
  revertOngoing,
  markRejected,
  markRungGone,
  markLeft,
  rungPendingUserIds,
  setRingTimer,
  clearRingTimer,
  setGraceTimer,
  clearGraceTimer,
  clearUserGraceTimers,
  beginTerminal,
  remove,
  reconcileOnBoot,
  shutdown,
};
