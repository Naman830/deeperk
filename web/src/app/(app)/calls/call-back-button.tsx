"use client";

import { toast } from "react-toastify";
import { Phone, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCallPhase, getOngoingCall } from "@/lib/call/call-store";
import { joinCall, startCall } from "@/lib/call/session";
import type { CallKind } from "@/lib/call/types";

// Starts the call IN PLACE, no navigation — getUserMedia and audio priming must
// stay inside the click gesture. Store reads live in the handler, never render.
export function CallBackButton({
  conversationId,
  kind,
  label,
  size = "icon-sm",
  variant = "ghost",
  text,
  className,
}: {
  conversationId: string;
  kind: CallKind;
  /** Accessible name for the icon-only form; ignored once `text` renders. */
  label: string;
  size?: "icon-sm" | "sm" | "default";
  variant?: "ghost" | "default" | "outline";
  /** Visible label for the detail-pane CTA form. */
  text?: string;
  className?: string;
}) {
  function onClick() {
    if (getCallPhase() !== "idle") {
      toast.error("You're already in a call");
      return;
    }
    if (getOngoingCall(conversationId)) joinCall(conversationId);
    else void startCall(conversationId, kind);
  }

  return (
    <Button size={size} variant={variant} aria-label={text ? undefined : label} onClick={onClick} className={className}>
      {kind === "VIDEO" ? <Video /> : <Phone />}
      {text}
    </Button>
  );
}
