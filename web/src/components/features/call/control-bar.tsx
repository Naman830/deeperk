import { Mic, MicOff, PhoneOff, Video, VideoOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { hangUp, toggleCamera, toggleMic } from "@/lib/call/session";

// No "use client": rendered inside call-provider's boundary.

export function ControlBar({
  micMuted,
  cameraOff,
  showCamera,
}: {
  micMuted: boolean;
  cameraOff: boolean;
  /** VIDEO call with a working camera — audio calls get no dead camera button. */
  showCamera: boolean;
}) {
  return (
    <footer className="flex h-20 shrink-0 items-center justify-center gap-4">
      <Button
        variant="secondary"
        size="icon-lg"
        className="rounded-full"
        aria-label={micMuted ? "Unmute microphone" : "Mute microphone"}
        aria-pressed={micMuted}
        onClick={toggleMic}
      >
        {micMuted ? <MicOff /> : <Mic />}
      </Button>
      {showCamera && (
        <Button
          variant="secondary"
          size="icon-lg"
          className="rounded-full"
          aria-label={cameraOff ? "Turn camera on" : "Turn camera off"}
          aria-pressed={cameraOff}
          onClick={toggleCamera}
        >
          {cameraOff ? <VideoOff /> : <Video />}
        </Button>
      )}
      <Button
        size="icon-lg"
        className="bg-destructive hover:bg-destructive/80 rounded-full text-white"
        aria-label="Hang up"
        onClick={hangUp}
      >
        <PhoneOff />
      </Button>
    </footer>
  );
}
