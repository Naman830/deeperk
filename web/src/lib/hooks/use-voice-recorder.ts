import { useCallback, useEffect, useRef, useState } from "react";

/**
 * MediaRecorder wrapper for the composer's voice notes.
 *
 * Three states, matching the confirmed UX: idle → recording (tap the mic) →
 * stopped (the 2-minute cap fired; the take is held and still sendable).
 * `finish()` works from either live state — it stops a live recorder first —
 * and `cancel()` discards from either. Every path stops the mic tracks: a
 * lingering track keeps the browser's recording indicator lit, which reads as
 * "this app is spying on me".
 */

export type VoiceRecording = { blob: Blob; mime: string; durationMs: number };

type VoiceRecorderStatus = "idle" | "recording" | "stopped";

// First supported wins. Chrome/Firefox record webm/opus; Safari records
// mp4/AAC. The upload route's sniff accepts all three containers.
const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? null;
}

export function useVoiceRecorder(maxMs: number) {
  const [status, setStatus] = useState<VoiceRecorderStatus>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const durationRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Resolved by the recorder's onstop, so finish() can await the final chunk. */
  const stoppedRef = useRef<Promise<void> | null>(null);

  const clearTimers = useCallback(() => {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
  }, []);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  /** Stop the live recorder, keeping the take. Used by the cap and by finish(). */
  const stopRecorder = useCallback(() => {
    clearTimers();
    durationRef.current = Date.now() - startedAtRef.current;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    releaseStream();
  }, [clearTimers, releaseStream]);

  /** Returns an error message to show inline, or null on success. */
  const start = useCallback(async (): Promise<string | null> => {
    if (recorderRef.current) return null; // already recording
    const mimeType = pickMimeType();
    if (!mimeType || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return "Voice messages aren't supported in this browser";
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return "Microphone access was denied. Check your browser's site permissions.";
    }

    const recorder = new MediaRecorder(stream, { mimeType });
    chunksRef.current = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunksRef.current.push(event.data);
    };
    stoppedRef.current = new Promise((resolve) => {
      recorder.onstop = () => resolve();
    });

    streamRef.current = stream;
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    durationRef.current = 0;
    setElapsedMs(0);
    setStatus("recording");
    // A 1s timeslice so chunks flow as they happen — one giant stop-time chunk
    // is where Safari has historically dropped audio.
    recorder.start(1000);

    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 250);
    capRef.current = setTimeout(() => {
      stopRecorder();
      setElapsedMs(durationRef.current);
      setStatus("stopped"); // cap hit: hold the take, still sendable
    }, maxMs);
    return null;
  }, [maxMs, stopRecorder]);

  /** Stop (if live) and hand back the take. Null if there's nothing recorded. */
  const finish = useCallback(async (): Promise<VoiceRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder) return null;
    if (recorder.state !== "inactive") stopRecorder();
    await stoppedRef.current;

    recorderRef.current = null;
    stoppedRef.current = null;
    setStatus("idle");
    setElapsedMs(0);

    const mime = recorder.mimeType || "audio/webm";
    const blob = new Blob(chunksRef.current, { type: mime });
    chunksRef.current = [];
    if (blob.size === 0) return null;
    return { blob, mime, durationMs: durationRef.current };
  }, [stopRecorder]);

  const cancel = useCallback(() => {
    stopRecorder();
    recorderRef.current = null;
    stoppedRef.current = null;
    chunksRef.current = [];
    setStatus("idle");
    setElapsedMs(0);
  }, [stopRecorder]);

  // Unmount (navigating away mid-recording) must release the mic — without
  // setState, which is an impure no-op once the component is gone.
  useEffect(
    () => () => {
      stopRecorder();
      recorderRef.current = null;
      stoppedRef.current = null;
      chunksRef.current = [];
    },
    [stopRecorder],
  );

  return { status, elapsedMs, start, finish, cancel };
}
