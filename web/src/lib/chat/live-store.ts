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
const listeners = new Set<() => void>();

// getSnapshot must return a referentially identical value between calls or
// React throws "The result of getSnapshot should be cached to avoid an infinite
// loop". One frozen empty array, shared.
const EMPTY: readonly ChatMessage[] = Object.freeze([]);

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

export function markLiveMessageDeleted(conversationId: string, messageId: string, deletedAt: string): void {
  const marks = deletedMarks.get(conversationId) ?? new Map<string, string>();
  marks.set(messageId, deletedAt);
  deletedMarks.set(conversationId, marks);
  // Clone even when the message isn't in the buffer: useSyncExternalStore only
  // re-renders on a snapshot identity change, and the mark alone doesn't make one.
  buffers.set(conversationId, [...(buffers.get(conversationId) ?? [])]);
  emit();
}

export function clearLiveMessages(): void {
  buffers.clear();
  deletedMarks.clear();
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
  if (live.length === 0 && deletedMarks.size === 0) return history;
  const byId = new Map<string, ChatMessage>();
  for (const msg of history) byId.set(msg.id, msg);
  for (const msg of live) byId.set(msg.id, msg);
  return [...byId.values()].map(applyDeletedMark).sort(compareMessages);
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
