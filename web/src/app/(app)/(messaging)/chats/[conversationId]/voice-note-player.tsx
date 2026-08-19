import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";

// No "use client": rendered by message-bubble, which is already inside
// chat-thread's client boundary — same posture as the rest of this folder.

/**
 * One note plays at a time, chat-app convention. A module-level ref rather
 * than context: the players never re-render each other, the newly-played
 * element just pauses whichever was live.
 */
let activeAudio: HTMLAudioElement | null = null;

/** Compact voice-note player: play/pause, seekable progress, elapsed/total.
 *
 * `durationMs` (from Cloudinary's probe, via the DB) is the primary total —
 * a Chrome-recorded webm carries no duration header, so the element itself
 * reports Infinity until the whole file has been scanned. The element's
 * metadata is only a fallback for rows that predate the column.
 */
export function VoiceNotePlayer({
  src,
  mime,
  durationMs,
}: {
  src: string;
  mime: string | null;
  durationMs: number | null;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [positionMs, setPositionMs] = useState(0);
  const [metadataMs, setMetadataMs] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // The element's real duration can outrun the probe — trust the longer, or
  // the seek bar clamps short of the end.
  const totalMs = durationMs === null && metadataMs === null ? null : Math.max(durationMs ?? 0, metadataMs ?? 0);

  // Pause on unmount (thread closed, message deleted) or the audio keeps
  // playing with no visible control left to stop it.
  useEffect(() => {
    // Captured once at mount — reading the ref inside the cleanup itself is the
    // stale-ref shape react-hooks warns on, and the element never changes.
    const audio = audioRef.current;
    return () => {
      if (audio && !audio.paused) audio.pause();
      if (activeAudio === audio) activeAudio = null;
    };
  }, []);

  function toggle() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      if (activeAudio && activeAudio !== audio) activeAudio.pause();
      activeAudio = audio;
      void audio.play().catch(() => {
        setPlaying(false);
        setFailed(true);
      });
    } else {
      audio.pause();
    }
  }

  function seek(nextMs: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = nextMs / 1000;
    setPositionMs(nextMs);
  }

  return (
    <span className="flex w-56 max-w-full items-center gap-2 py-0.5">
      <audio
        ref={audioRef}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPositionMs(0);
        }}
        onTimeUpdate={(event) => setPositionMs(event.currentTarget.currentTime * 1000)}
        onLoadedMetadata={(event) => {
          const seconds = event.currentTarget.duration;
          if (Number.isFinite(seconds)) setMetadataMs(seconds * 1000);
        }}
        onError={() => {
          setFailed(true);
          setPlaying(false);
        }}
      >
        {/* A failing <source> fires error on the source element, not the media
            element — without this handler a dead URL leaves an inert button. */}
        <source src={src} type={mime ?? undefined} onError={() => setFailed(true)} />
      </audio>

      <button
        type="button"
        aria-label={failed ? "Voice message unavailable" : playing ? "Pause voice message" : "Play voice message"}
        disabled={failed}
        onClick={toggle}
        className="grid size-8 shrink-0 place-items-center rounded-full bg-current/15 transition-transform active:scale-95 disabled:opacity-50"
      >
        {playing ? <Pause size={14} /> : <Play size={14} className="translate-x-px" />}
      </button>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={Math.max(totalMs ?? 0, 1)}
          step={100}
          value={Math.min(positionMs, totalMs ?? positionMs)}
          disabled={totalMs === null || failed}
          onChange={(event) => seek(Number(event.target.value))}
          className="h-1 w-full min-w-0 cursor-pointer accent-current disabled:cursor-default"
        />
        <span className="text-[11px] tabular-nums opacity-70">
          {failed ? "Couldn't load" : formatClock(positionMs)}
          {!failed && totalMs !== null && ` / ${formatClock(totalMs)}`}
        </span>
      </span>
    </span>
  );
}

export function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
