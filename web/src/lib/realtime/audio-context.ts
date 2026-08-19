/**
 * The one AudioContext per tab, shared by the notification blip and the call
 * ringtone.
 *
 * There is no permission API for audio: a context created outside a user
 * gesture starts `suspended`, and on iOS it must be *constructed* during the
 * gesture, not merely resumed. realtime-provider's first-gesture listeners
 * prime it; call accept/start clicks prime it again so in-call audio never
 * depends on prior priming. A silent no-op is deliberate — there is nothing
 * the user could act on if we warned.
 */

type Ctor = typeof AudioContext;

let context: AudioContext | null = null;

function getConstructor(): Ctor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null;
}

/** Call from inside a real user gesture. Safe to call repeatedly. */
export function primeAudioContext(): void {
  if (context) {
    if (context.state === "suspended") void context.resume();
    return;
  }
  const Ctor = getConstructor();
  if (!Ctor) return;
  try {
    context = new Ctor();
    void context.resume();
  } catch {
    context = null;
  }
}

/** Re-arm after an OS interruption suspended the context. No gesture needed
 *  once it has been unlocked at least once. */
export function resumeAudioContext(): void {
  if (context?.state === "suspended") void context.resume();
}

/** Null until first primed. Callers must check `state === "running"`. */
export function getAudioContext(): AudioContext | null {
  return context;
}
