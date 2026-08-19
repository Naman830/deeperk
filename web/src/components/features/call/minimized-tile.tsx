import { useRef, useState } from "react";
import { avatarUrl } from "@/lib/avatar-url";
import { cn } from "@/lib/utils";
import {
  setMinimized,
  setMinimizedCorner,
  type CallState,
  type MinimizedCorner,
} from "@/lib/call/call-store";
import { CallDuration } from "./call-duration";
import { VideoTile } from "./video-tile";

// No "use client": rendered inside call-provider's boundary.

// Bottom corners clear the mobile tab bar (the shell's pb-16), like the shell does.
const CORNER_CLASS: Record<MinimizedCorner, string> = {
  "top-left": "top-4 left-4",
  "top-right": "top-4 right-4",
  "bottom-left": "bottom-20 left-4 md:bottom-4",
  "bottom-right": "bottom-20 right-4 md:bottom-4",
};

const DRAG_THRESHOLD_PX = 5;

export function MinimizedTile({ state }: { state: CallState }) {
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; moved: boolean } | null>(null);
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null);

  const featured = state.participants.find((p) => p.stream !== null) ?? state.participants[0] ?? null;
  const name = featured ? `${featured.user.firstName} ${featured.user.lastName ?? ""}`.trim() : "You";

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const x = event.clientX - drag.startX;
    const y = event.clientY - drag.startY;
    // Below the threshold it's still a click — a jittery finger must not eat the restore.
    if (!drag.moved && Math.hypot(x, y) < DRAG_THRESHOLD_PX) return;
    drag.moved = true;
    setOffset({ x, y });
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setOffset(null);
    if (!drag.moved) {
      setMinimized(false);
      return;
    }
    // Corner snap: whichever quadrant the pointer let go in.
    const vertical = event.clientY < window.innerHeight / 2 ? "top" : "bottom";
    const horizontal = event.clientX < window.innerWidth / 2 ? "left" : "right";
    setMinimizedCorner(`${vertical}-${horizontal}` as MinimizedCorner);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    setOffset(null);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label="Restore call window"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          setMinimized(false);
        }
      }}
      className={cn(
        "bg-card fixed z-50 w-56 cursor-pointer touch-none overflow-hidden rounded-xl border shadow-lg select-none",
        CORNER_CLASS[state.minimizedCorner],
      )}
      style={offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : undefined}
    >
      <VideoTile
        stream={featured ? featured.stream : state.localStream}
        isLocal={!featured}
        mirrored={!featured}
        name={name}
        avatarSrc={featured ? avatarUrl(featured.user.avatarPublicId, 256) : null}
        firstName={featured ? featured.user.firstName : "You"}
        lastName={featured?.user.lastName}
        micMuted={featured ? featured.micMuted : state.micMuted}
        cameraOff={featured ? featured.cameraOff : state.cameraOff}
        className="aspect-video w-full"
      />
      <div className="flex items-center justify-between px-2.5 py-1.5">
        <span className="text-xs font-medium">
          {state.phase === "outgoing" ? (state.joining ? "Joining…" : "Ringing…") : "In call"}
        </span>
        <CallDuration startedAt={state.startedAt} className="text-muted-foreground text-xs tabular-nums" />
      </div>
    </div>
  );
}
