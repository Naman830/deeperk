import { getAudioContext, primeAudioContext, resumeAudioContext } from "./audio-context";

/**
 * The notification sound (Docs/chat/chat.md §6), synthesised rather than
 * shipped as a binary asset.
 *
 * The AudioContext itself lives in audio-context.ts, shared with the call
 * ringtone; these thin delegates keep the public API stable so
 * realtime-provider's priming listeners now unlock both sounds. The
 * first-notification-is-silent constraint documented there applies here too.
 */

let lastPlayedAt = 0;

const THROTTLE_MS = 2000; // a group burst must not machine-gun

/** Call from inside a real user gesture. Safe to call repeatedly. */
export function primeBlip(): void {
  primeAudioContext();
}

/** Re-arm after an OS interruption suspended the context. No gesture needed
 *  once it has been unlocked at least once. */
export function resumeBlip(): void {
  resumeAudioContext();
}

export function playBlip(): void {
  const context = getAudioContext();
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
