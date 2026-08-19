import { useSyncExternalStore } from "react";
import { Phone, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { joinCall } from "@/lib/call/session";
import { getCallState, getOngoingCall, getServerOngoingCall, subscribeCall } from "@/lib/call/call-store";

// No "use client": rendered from chat-thread.tsx, inside its boundary.

const getServerCallId = (): string | null => null;

/** GROUP threads only — the caller gates on conversation.type. */
export function JoinCallBanner({ conversationId }: { conversationId: string }) {
  const entry = useSyncExternalStore(subscribeCall, () => getOngoingCall(conversationId), getServerOngoingCall);
  // Selector, not the full state: useSyncExternalStore re-renders only when the
  // snapshot VALUE changes, so this stays quiet through call plumbing ticks.
  const activeCallId = useSyncExternalStore(subscribeCall, () => getCallState().callId, getServerCallId);

  if (!entry || entry.callId === activeCallId) return null;
  const kindWord = entry.kind === "VIDEO" ? "video" : "audio";
  const Icon = entry.kind === "VIDEO" ? Video : Phone;

  return (
    <div className="bg-primary/10 flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <Icon size={14} className="text-primary shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">
        Ongoing {kindWord} call · {entry.participantCount} in call
      </span>
      <Button size="sm" onClick={() => joinCall(conversationId)}>
        Join
      </Button>
    </div>
  );
}
