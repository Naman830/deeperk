// Per-conversation composer drafts, in a module-level store rather than React
// context. A keystroke used to rebuild the realtime context value and re-render
// every consumer — including every message bubble on screen. Out here, only the
// composer subscribed to the affected conversation re-renders.
//
// Same useSyncExternalStore protocol as live-store.ts. Module lifetime means a
// draft survives navigation exactly as it did as provider state.

type Listener = () => void;

const drafts = new Map<string, string>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeDrafts(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The snapshot is the string itself — a subscriber keyed to one conversation
 *  re-renders only when that conversation's draft changes. */
export function getDraft(conversationId: string): string {
  return drafts.get(conversationId) ?? "";
}

export function setDraft(conversationId: string, value: string): void {
  if (getDraft(conversationId) === value) return;
  if (value === "") drafts.delete(conversationId);
  else drafts.set(conversationId, value);
  emit();
}
