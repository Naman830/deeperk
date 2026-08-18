/**
 * The notification sound (Docs/chat/chat.md §6), synthesised rather than shipped
 * as a binary asset.
 *
 * chat.md doesn't anticipate the constraint that governs this: **there is no
 * permission API for audio.** An AudioContext created before any user gesture
 * starts `suspended`, and on iOS it must be *constructed* during the gesture,
 * not merely resumed. So the very first notification in a freshly loaded tab
 * nobody has clicked is silent, always, on every browser. That's platform
 * policy, not a bug — hence a silent no-op rather than a thrown error or a
 * console warning about something the user cannot act on.
 */

type Ctor = typeof AudioContext;

let context: AudioContext | null = null;
let lastPlayedAt = 0;

const THROTTLE_MS = 2000; // a group burst must not machine-gun

function getConstructor(): Ctor | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: Ctor }).webkitAudioContext ?? null;
}

/** Call from inside a real user gesture. Safe to call repeatedly. */
export function primeBlip(): void {
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
export function resumeBlip(): void {
  if (context?.state === "suspended") void context.resume();
}

export function playBlip(): void {
  if (!context || context.state !== "running") return;
  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;

  try {
    const start = context.currentTime;
    const gain = context.createGain();
    gain.connect(context.destination);
    // Exponential ramp to near-silence rather than an abrupt stop, which clicks.
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);

    for (const [frequency, offset] of [
      [880, 0],
      [1320, 0.07],
    ] as const) {
      const oscillator = context.createOscillator();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(frequency, start + offset);
      oscillator.connect(gain);
      oscillator.start(start + offset);
      oscillator.stop(start + offset + 0.12);
    }
  } catch {
    // Never let a decorative sound break message delivery.
  }
}
