import { Minimize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { avatarUrl } from "@/lib/avatar-url";
import { hangUp } from "@/lib/call/session";
import { setMinimized, type CallParticipant, type CallState } from "@/lib/call/call-store";
import { CallDuration } from "./call-duration";
import { ControlBar } from "./control-bar";
import { VideoTile } from "./video-tile";

// No "use client": rendered inside call-provider's boundary.

function participantName(p: CallParticipant): string {
  return `${p.user.firstName} ${p.user.lastName ?? ""}`.trim();
}

export function CallSurface({ state }: { state: CallState }) {
  const isGroup = state.conversationType === "GROUP";
  const remote = state.participants;
  const showCamera = state.kind === "VIDEO" && !state.cameraless;

  return (
    <div className="bg-background fixed inset-0 z-50 flex flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 px-4">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">{state.conversationName ?? "Call"}</h2>
          <p className="text-muted-foreground text-xs">
            {state.phase === "outgoing" ? (
              state.joining ? "Joining…" : "Ringing…"
            ) : (
              <CallDuration startedAt={state.startedAt} />
            )}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Minimize call" onClick={() => setMinimized(true)}>
          <Minimize2 />
        </Button>
      </header>

      {state.phase === "reconnecting" && (
        <div className="bg-destructive/10 text-destructive shrink-0 px-4 py-1.5 text-center text-xs" role="status">
          Reconnecting…
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {state.mediaError ? (
          // The inline home for a getUserMedia failure — the reason the surface
          // opens before the permission prompt.
          <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            <p className="text-destructive max-w-sm text-sm" role="alert">
              {state.mediaError}
            </p>
            <Button variant="outline" onClick={hangUp}>
              Close
            </Button>
          </div>
        ) : isGroup ? (
          <div className="grid h-full auto-rows-fr grid-cols-2 gap-2 p-2">
            <VideoTile
              stream={state.localStream}
              isLocal
              mirrored
              name="You"
              firstName="You"
              micMuted={state.micMuted}
              cameraOff={state.cameraOff}
              className="rounded-xl"
            />
            {remote.map((p) => (
              <VideoTile
                key={p.user.id}
                stream={p.stream}
                name={participantName(p)}
                avatarSrc={avatarUrl(p.user.avatarPublicId, 256)}
                firstName={p.user.firstName}
                lastName={p.user.lastName}
                micMuted={p.micMuted}
                cameraOff={p.cameraOff}
                connecting={p.connection === "connecting"}
                className="rounded-xl"
              />
            ))}
          </div>
        ) : remote[0] ? (
          <>
            <VideoTile
              stream={remote[0].stream}
              name={participantName(remote[0])}
              avatarSrc={avatarUrl(remote[0].user.avatarPublicId, 256)}
              firstName={remote[0].user.firstName}
              lastName={remote[0].user.lastName}
              micMuted={remote[0].micMuted}
              cameraOff={remote[0].cameraOff}
              connecting={remote[0].connection === "connecting"}
              className="h-full w-full"
            />
            {state.localStream && (
              <VideoTile
                stream={state.localStream}
                isLocal
                mirrored
                name="You"
                firstName="You"
                micMuted={state.micMuted}
                cameraOff={state.cameraOff}
                className="absolute right-4 bottom-4 aspect-[3/4] w-28 rounded-xl border shadow-lg md:w-40"
              />
            )}
          </>
        ) : (
          // Outgoing ring, nobody joined yet — own preview fills the stage.
          <VideoTile
            stream={state.localStream}
            isLocal
            mirrored
            name="You"
            firstName="You"
            micMuted={state.micMuted}
            cameraOff={state.cameraOff}
            className="h-full w-full"
          />
        )}
      </div>

      {!state.mediaError && (
        <ControlBar micMuted={state.micMuted} cameraOff={state.cameraOff} showCamera={showCamera} />
      )}
    </div>
  );
}
