const { db, schema, ops } = require("./db");
const { env } = require("./env");

const { user, privacySettings } = schema;
const { eq, sql } = ops;

/**
 * Presence (Docs/chat/chat.md §2.6).
 *
 * The multi-tab counter: first tab connecting flips you online, last tab
 * disconnecting flips you offline. Single-server assumption, same as the rest
 * of the in-memory state here.
 */
const online = new Map(); // userId -> Set<socketId>

/** @returns true when this is the user's FIRST socket. */
function add(userId, socketId) {
  let sockets = online.get(userId);
  if (!sockets) {
    sockets = new Set();
    online.set(userId, sockets);
  }
  sockets.add(socketId);
  return sockets.size === 1;
}

/** @returns true when this was the user's LAST socket. */
function remove(userId, socketId) {
  const sockets = online.get(userId);
  if (!sockets) return false;
  sockets.delete(socketId);
  if (sockets.size > 0) return false;
  // Delete the key, don't leave an empty Set — otherwise this is an unbounded
  // map of empty Sets keyed by every user who ever connected.
  online.delete(userId);
  return true;
}

function count(userId) {
  const sockets = online.get(userId);
  return sockets ? sockets.size : 0;
}

function onlineUserIds() {
  return [...online.keys()];
}

/**
 * Whether this user's presence may be broadcast at all.
 *
 * chat.md §2.6 says presence is filtered by the *recipient's* onlineStatus.
 * It's the subject's — and since the audience is only EVERYONE/NOBODY (no
 * FRIENDS tier exists, profile.md §3), it's a per-subject boolean rather than
 * a per-viewer relation. That is what lets this be one lookup at connect time
 * and a plain room broadcast, instead of a privacy check per recipient.
 *
 * Mirrors presenceVisible() in web/src/lib/profile/privacy.ts. When a FRIENDS
 * tier lands, both have to change together and this becomes per-recipient.
 */
async function readsPresencePublicly(userId) {
  const rows = await db
    .select({ onlineStatus: privacySettings.onlineStatus })
    .from(privacySettings)
    .where(eq(privacySettings.userId, userId))
    .limit(1);
  // No row is the common case — nothing at signup creates one — and reads as
  // EVERYONE, the same value as the column default.
  return (rows[0]?.onlineStatus ?? "EVERYONE") === "EVERYONE";
}

async function markOnline(userId) {
  await db.update(user).set({ isOnline: true }).where(eq(user.id, userId));
}

async function markOffline(userId) {
  await db
    .update(user)
    .set({ isOnline: false, lastSeenAt: sql`now()` })
    .where(eq(user.id, userId));
}

/**
 * Clear presence left behind by a crash, before accepting any connection.
 *
 * This is the only thing that fixes a SIGKILL, a panic, or power loss — and in
 * development it runs constantly, because nodemon restarts on every save.
 * lastSeenAt is deliberately not touched: the last known value is the truthful
 * answer, and overwriting it with "now" would claim the user was here.
 */
async function reconcileOnBoot() {
  if (!env.SINGLE_INSTANCE) {
    console.warn("[socket] SOCKET_SINGLE_INSTANCE=false — skipping presence reset.");
    return;
  }
  await db.update(user).set({ isOnline: false }).where(eq(user.isOnline, true));
}

/** Best-effort flush on SIGTERM, which is what nodemon sends on every restart. */
async function flushAllOffline() {
  const ids = onlineUserIds();
  if (ids.length === 0) return;
  await Promise.allSettled(ids.map((id) => markOffline(id)));
}

module.exports = {
  add,
  remove,
  count,
  onlineUserIds,
  readsPresencePublicly,
  markOnline,
  markOffline,
  reconcileOnBoot,
  flushAllOffline,
};
