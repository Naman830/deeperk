/**
 * In-memory fixed-window limiter for the socket server (Docs/chat/chat.md §1, §7).
 *
 * Why in-memory here, when web/src/lib/rate-limit.ts is DB-backed: these are
 * short windows on the hottest path in the app. A Neon HTTP round trip per
 * message would roughly double send latency, and losing at most ten seconds of
 * accounting on restart is worth nothing to an attacker.
 *
 * The inverse is also true and is why the long windows stayed in Next: a
 * 5-per-day limit held in a Map that nodemon resets on every file save is not
 * a limit at all.
 *
 * Same fixed-window semantics as checkRateLimit, so the two behave alike — note
 * that means a straddle across the boundary can permit up to 2x max.
 */
const buckets = new Map();

/** Keys must derive from socket.data.user.id only. A client-supplied key would
 *  make this Map itself the denial-of-service. */
function allow(key, windowMs, max) {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    buckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

// Without this the Map grows forever, keyed by every user who ever connected.
const SWEEP_INTERVAL_MS = 60_000;
const STALE_AFTER_MS = 5 * 60_000;

const sweeper = setInterval(() => {
  const cutoff = Date.now() - STALE_AFTER_MS;
  for (const [key, bucket] of buckets) {
    if (bucket.windowStart < cutoff) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

const LIMITS = {
  // 30 messages / 10 seconds per user (chat.md §7).
  message: { windowMs: 10_000, max: 30 },
  // Not in §7. Uncapped, a scripted client emitting typing events has the
  // server fan each one out to every room member — amplification, not just load.
  typing: { windowMs: 10_000, max: 10 },
  // Not in §7 either. §7 calls mark-as-read "cheap, idempotent" — it is an
  // UPDATE, and idempotent is not free.
  read: { windowMs: 10_000, max: 20 },
  delete: { windowMs: 60_000, max: 20 },
  // Hiding a message writes one tiny row and is visible to nobody else, so
  // it is looser than delete-for-everyone. Higher than it looks because
  // multi-select fires one of these per selected message.
  deleteForMe: { windowMs: 60_000, max: 60 },
  // An UPDATE of one row, own messages only. Generous because a typo fixed
  // three times in a row is normal behaviour, not abuse.
  edit: { windowMs: 60_000, max: 30 },
  // Emitted by the recipient once per incoming message, so it tracks the send
  // limit rather than the read limit. Same runaway-client guard as `read`.
  delivered: { windowMs: 10_000, max: 30 },
};

module.exports = { allow, LIMITS };
