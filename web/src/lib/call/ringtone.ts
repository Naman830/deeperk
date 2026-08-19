import { getAudioContext } from "@/lib/realtime/audio-context";

/**
 * Synthesized ringtone — the North American ringback pair (440+480 Hz),
 * 2s on / 2s off. No binary asset, same priming constraint as blip.ts: in a
 * never-clicked tab the context isn't running and the first ring is silent by
 * browser policy — the incoming-call modal still shows.
 */

const TONE_SEC = 2;
const CYCLE_MS = 4000;
const LEVEL = 0.05;
const RAMP_SEC = 0.015; // 15ms envelopes — an unshaped sine edge clicks audibly

let cycleTimer: ReturnType<typeof setInterval> | null = null;
let liveGain: GainNode | null = null;
let liveOscillators: OscillatorNode[] = [];

function burst(context: AudioContext): void {
  const start = context.currentTime;
  const stop = start + TONE_SEC;
  const gain = context.createGain();
  gain.connect(context.destination);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(LEVEL, start + RAMP_SEC);
  gain.gain.setValueAtTime(LEVEL, stop - RAMP_SEC);
  gain.gain.exponentialRampToValueAtTime(0.0001, stop);
  liveGain = gain;
  liveOscillators = [440, 480].map((frequency) => {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.connect(gain);
    oscillator.start(start);
    oscillator.stop(stop);
    return oscillator;
  });
}

/** Idempotent. No-op unless the shared context is already running. */
export function startRingtone(): void {
  if (cycleTimer !== null) return;
  const context = getAudioContext();
  if (!context || context.state !== "running") return;
  try {
    burst(context);
  } catch {
    return;
  }
  cycleTimer = setInterval(() => {
    const current = getAudioContext();
    if (!current || current.state !== "running") return;
    try {
      burst(current);
    } catch {
      // Decorative — never let the ringtone break the ring.
    }
  }, CYCLE_MS);
}

/** Idempotent. Ramps the current burst out instead of cutting it (clicks). */
export function stopRingtone(): void {
  if (cycleTimer !== null) {
    clearInterval(cycleTimer);
    cycleTimer = null;
  }
  const context = getAudioContext();
  if (liveGain && context) {
    try {
      const now = context.currentTime;
      liveGain.gain.cancelScheduledValues(now);
      liveGain.gain.setValueAtTime(Math.max(liveGain.gain.value, 0.0001), now);
      liveGain.gain.exponentialRampToValueAtTime(0.0001, now + RAMP_SEC);
      for (const oscillator of liveOscillators) oscillator.stop(now + RAMP_SEC + 0.005);
    } catch {
      // Already stopped.
    }
  }
  liveGain = null;
  liveOscillators = [];
}
