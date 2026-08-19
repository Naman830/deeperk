import { useSyncExternalStore } from "react";

/**
 * A once-a-second clock, as external state — the 1s sibling of use-now.ts.
 *
 * Deliberately a separate hook rather than a faster TICK_MS on useNow: useNow's
 * minute granularity is what keeps the sidebar's mute badges from re-rendering
 * sixty times a minute, and only the two call-duration readouts want seconds.
 * Same rules as over there: one shared interval, and a cached snapshot or React
 * loops on "getSnapshot should be cached".
 */

const TICK_MS = 1000;

const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
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

// Zero on the server — a duration rendered from it shows 0:00 for at most one
// tick before the first client snapshot corrects it.
function getServerSnapshot(): number {
  return 0;
}

export function useSecondTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
