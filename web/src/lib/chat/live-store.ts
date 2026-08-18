import type { ChatMessage } from "./types";

/**
 * Messages that arrived over the socket, per conversation.
 *
 * Read with useSyncExternalStore rather than useState, for the same reason
 * theme-provider.tsx uses it: the server cannot see this data. A lazy useState
 * initializer would run during SSR (buffer empty) and again on the first client
 * render (buffer possibly not empty) — a hydration mismatch — while merging in
 * an effect is a setState synchronously inside an effect, which React 19's
 * react-hooks/set-state-in-effect rule forbids and which the repo has already
 * been bitten by once (see UserSearchResults).
 *
 * The buffer starts filling the moment the socket connects, which is app mount
 * — well before any thread page exists. That is the half of "no missing
 * messages" that covers the gap between the server component's DB read and the
 * client's first render; GET /messages?after= covers the reconnect gap.
 */

const MAX_PER_CONVERSATION = 200;

const buffers = new Map<string, ChatMessage[]>();
// Tombstones by (conversationId, messageId). Kept separately from the buffer
// because a delete can target a message that only exists in a thread's SSR/
// paginated history state, which this store never holds — mergeMessages applies
// these marks over whatever copy it is given.
const deletedMarks = new Map<string, Map<string, string>>();
// "Delete for me", kept separate from deletedMarks because it means something
// different: a tombstone is a message everyone can see was removed, this is a
// message that, for this user, is simply not there. So it filters rather than
// rewrites, and it is never broadcast to the room.
const hiddenIds = new Map<string, Set<string>>();
/**
 * Messages that are ON THEIR WAY OUT — hidden, but still rendered so the row
 * can collapse instead of vanishing.
 *
 * Without this the feature reads as broken even though it works: hiddenIds
 * filters the message out of the very next snapshot, so the <li> unmounts on
 * the same tick and no exit transition ever runs — the message pops out and
 * everything below jumps up by its height. An id sits here for EXIT_MS while
 * the bubble animates its own height and opacity to zero, then moves to
 * hiddenIds and unmounts into space that has already closed.
 */
const exitingIds = new Map<string, Set<string>>();
/** Edits that arrived over the socket, applied over whatever copy is rendered
 *  — same reasoning as deletedMarks, since an edit can target a message that
 *  only exists in a thread's paginated history state. */
const editedMarks = new Map<string, Map<string, { body: string; editedAt: string }>>();
const listeners = new Set<() => void>();

// getSnapshot must return a referentially identical value between calls or
// React throws "The result of getSnapshot should be cached to avoid an infinite
// loop". One frozen empty array, shared.
const EMPTY: readonly ChatMessage[] = Object.freeze([]);
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

/** Long enough for the collapse to read as motion, short enough that a
 *  mis-tap's undo window doesn't feel like lag. Mirrored by the CSS duration
 *  on the bubble — if you change one, change both. */
export const EXIT_MS = 180;

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeLive(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLiveMessages(conversationId: string): readonly ChatMessage[] {
  return buffers.get(conversationId) ?? EMPTY;
}

/** Stable across renders, and always empty — the server has no live buffer. */
export function getServerLiveMessages(): readonly ChatMessage[] {
  return EMPTY;
}

export function pushLiveMessage(msg: ChatMessage): void {
  const current = buffers.get(msg.conversationId) ?? [];
  // The sender receives its own broadcast (their other tabs need it), and a
  // reconnect backfill can re-deliver. Dedupe on the server id — the only
  // identifier the SSR payload and the socket both agree on.
  if (current.some((existing) => existing.id === msg.id)) return;
  const next = [...current, msg].slice(-MAX_PER_CONVERSATION);
  buffers.set(msg.conversationId, next);
  emit();
}

export function pushLiveMessages(messages: ChatMessage[]): void {
  let changed = false;
  for (const msg of messages) {
    const current = buffers.get(msg.conversationId) ?? [];
    if (current.some((existing) => existing.id === msg.id)) continue;
    buffers.set(msg.conversationId, [...current, msg].slice(-MAX_PER_CONVERSATION));
    changed = true;
  }
  if (changed) emit();
}

export function getExitingIds(conversationId: string): ReadonlySet<string> {
  return exitingIds.get(conversationId) ?? EMPTY_IDS;
}

/** Stable across renders, and always empty — the server animates nothing. */
export function getServerExitingIds(): ReadonlySet<string> {
  return EMPTY_IDS;
}

export function markLiveMessageEdited(
  conversationId: string,
  messageId: string,
  body: string,
  editedAt: string,
): void {
  const marks = editedMarks.get(conversationId) ?? new Map<string, { body: string; editedAt: string }>();
  marks.set(messageId, { body, editedAt });
  editedMarks.set(conversationId, marks);
  buffers.set(conversationId, [...(buffers.get(conversationId) ?? [])]);
  emit();
}

export function markLiveMessageDeleted(conversationId: string, messageId: string, deletedAt: string): void {
  const marks = deletedMarks.get(conversationId) ?? new Map<string, string>();
  marks.set(messageId, deletedAt);
  deletedMarks.set(conversationId, marks);
  // Clone even when the message isn't in the buffer: useSyncExternalStore only
  // re-renders on a snapshot identity change, and the mark alone doesn't make one.
  buffers.set(conversationId, [...(buffers.get(conversationId) ?? [])]);
  emit();
}

/**
 * Two-step, and the delay is the whole point — see exitingIds above.
 *
 * Step one marks the message as leaving and re-renders, so the bubble picks up
 * its collapse transition. Step two, EXIT_MS later, actually hides it.
 */
export function markLiveMessageHidden(conversationId: string, messageId: string): void {
  // A new Set every time, never a mutation: useSyncExternalStore compares
  // snapshots by identity, so mutating in place would change nothing on screen.
  const exiting = new Set(exitingIds.get(conversationId) ?? []);
  if (exiting.has(messageId)) return;
  exiting.add(messageId);
  exitingIds.set(conversationId, exiting);
  emit();
  setTimeout(() => commitHidden(conversationId, messageId), EXIT_MS);
}

function commitHidden(conversationId: string, messageId: string): void {
  const hidden = hiddenIds.get(conversationId) ?? new Set<string>();
  hidden.add(messageId);
  hiddenIds.set(conversationId, hidden);

  const exiting = new Set(exitingIds.get(conversationId) ?? []);
  exiting.delete(messageId);
  exitingIds.set(conversationId, exiting);

  // Same reason as markLiveMessageDeleted: useSyncExternalStore only re-renders
  // on a snapshot identity change, and the mark alone doesn't make one.
  buffers.set(conversationId, [...(buffers.get(conversationId) ?? [])]);
  emit();
}

export function clearLiveMessages(): void {
  buffers.clear();
  deletedMarks.clear();
  hiddenIds.clear();
  exitingIds.clear();
  editedMarks.clear();
  emit();
}

/**
 * Merge server-rendered history with the live buffer.
 *
 * Sorted by (createdAt, id), never appended: `createdAt` is the database clock
 * and under neon-http each insert is its own transaction, so a message that
 * started earlier can commit later. Push order and reload order would otherwise
 * disagree, which looks exactly like a frontend bug.
 */
export function mergeMessages(history: ChatMessage[], live: readonly ChatMessage[]): ChatMessage[] {
  // hiddenIds belongs in this guard too. Without it, hiding a message that
  // exists only in the SSR history of an otherwise-quiet conversation returns
  // `history` untouched and the hide silently does nothing.
  if (live.length === 0 && deletedMarks.size === 0 && hiddenIds.size === 0 && editedMarks.size === 0) {
    return history;
  }
  const byId = new Map<string, ChatMessage>();
  for (const msg of history) byId.set(msg.id, msg);
  for (const msg of live) byId.set(msg.id, msg);
  // Note what is NOT filtered here: exitingIds. A message on its way out has to
  // stay in the list long enough to animate — it is hiddenIds, set EXIT_MS
  // later, that finally removes it.
  return [...byId.values()]
    .filter(isVisible)
    .map(applyEditedMark)
    .map(applyDeletedMark)
    .sort(compareMessages);
}

function applyEditedMark(msg: ChatMessage): ChatMessage {
  const mark = editedMarks.get(msg.conversationId)?.get(msg.id);
  // Skip if the server copy is already at or past this edit, so a refetch that
  // brings the newer body doesn't get overwritten by a stale mark.
  if (!mark || (msg.editedAt !== null && msg.editedAt >= mark.editedAt)) return msg;
  return { ...msg, body: mark.body, editedAt: mark.editedAt };
}

function isVisible(msg: ChatMessage): boolean {
  return !hiddenIds.get(msg.conversationId)?.has(msg.id);
}

function applyDeletedMark(msg: ChatMessage): ChatMessage {
  if (msg.deletedAt) return msg;
  const deletedAt = deletedMarks.get(msg.conversationId)?.get(msg.id);
  if (!deletedAt) return msg;
  return { ...msg, deletedAt, body: null, mediaUrl: null, mediaMime: null, mediaSize: null, mediaName: null };
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
