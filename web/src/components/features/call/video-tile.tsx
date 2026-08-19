import { MicOff } from "lucide-react";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { cn } from "@/lib/utils";

// No "use client": rendered inside call-provider's boundary.

export function VideoTile({
  stream,
  isLocal = false,
  mirrored = false,
  name,
  avatarSrc = null,
  firstName,
  lastName,
  micMuted = false,
  cameraOff = false,
  connecting = false,
  className,
}: {
  stream: MediaStream | null;
  isLocal?: boolean;
  /** Own camera preview — flipped so it reads like a mirror. */
  mirrored?: boolean;
  name: string;
  avatarSrc?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  micMuted?: boolean;
  cameraOff?: boolean;
  connecting?: boolean;
  className?: string;
}) {
  const hasVideo = stream !== null && stream.getVideoTracks().length > 0;
  const showVideo = hasVideo && !cameraOff;

  return (
    <div className={cn("relative overflow-hidden bg-neutral-950", className)}>
      {stream && (
        // The video element stays mounted even when the picture is hidden — for
        // remote tiles it is the AUDIO sink, and unmounting it would mute them.
        <video
          ref={(node) => {
            // srcObject can't be set as an attribute; the guard makes the
            // per-render ref invocation free.
            if (node && node.srcObject !== stream) node.srcObject = stream;
          }}
          autoPlay
          playsInline
          muted={isLocal}
          className={cn("h-full w-full object-cover", mirrored && "-scale-x-100", !showVideo && "hidden")}
        />
      )}
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <UserAvatar src={avatarSrc} firstName={firstName} lastName={lastName} size="lg" />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 flex max-w-[calc(100%-12px)] items-center gap-1 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white">
        {micMuted && <MicOff size={12} className="shrink-0" aria-label="Muted" />}
        <span className="truncate">{name}</span>
      </span>
      {connecting && (
        <span className="absolute top-1.5 right-1.5 rounded-full bg-black/50 px-2 py-0.5 text-xs text-white/80">
          Connecting…
        </span>
      )}
    </div>
  );
}
