import { useSyncExternalStore } from "react";

/**
 * The current time, as external state.
 *
 * "Is this conversation still muted?" is `mutedUntil > now`, and calling
 * Date.now() during render to answer it is an impure read — React 19's
 * react-hooks/purity rule rejects it, and rightly: the answer would change
 * without a re-render, so a mute would appear to last until something unrelated
 * happened to repaint.
 *
 * This makes the clock a subscription instead, so an expiring mute actually
 * lights the bell back up on its own. One shared interval for every consumer,
 * and a minute of granularity — nothing in this app cares about a mute lapsing
 * to the second, and a per-second tick would re-render the sidebar 60 times a
 * minute for nothing.
 */

const TICK_MS = 60_000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
// A cached value, not a fresh Date.now() per call: getSnapshot must return the
// same value between ticks or React loops on "getSnapshot should be cached".
let snapshot = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    snapshot = Date.now();
    timer = setInterval(() => {
      snapshot = Date.now();
      for (const item of listeners) item();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  if (snapshot === 0) snapshot = Date.now();
  return snapshot;
}

// Zero on the server, which reads as "nothing has expired yet". The first
// client render corrects it, and a mute that lapsed while the page was being
// rendered simply shows as muted for up to one tick.
function getServerSnapshot(): number {
  return 0;
}

export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** `mutedUntil > now`, with the clock read as external state. */
export function isMuted(mutedUntil: string | null | undefined, now: number): boolean {
  return mutedUntil != null && new Date(mutedUntil).getTime() > now;
}
