import { Phone, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startCall } from "@/lib/call/session";

// No "use client": rendered from thread-header.tsx, inside chat-thread's boundary.

/**
 * Never disabled on hidden presence — §2.1's offline/busy answers belong to the
 * server, and disabling here would leak what privacy hides.
 */
export function CallButtons({ conversationId }: { conversationId: string }) {
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Start audio call"
        onClick={() => void startCall(conversationId, "AUDIO")}
      >
        <Phone />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Start video call"
        onClick={() => void startCall(conversationId, "VIDEO")}
      >
        <Video />
      </Button>
    </>
  );
}
