"use client";

import { useEffect, useRef } from "react";
import { acquireSocket, releaseSocket } from "@/lib/realtime/socket";
import { attachCallSession } from "@/lib/call/session";
import { CallRoot } from "@/components/features/call/call-root";
import { useRealtime } from "./realtime-provider";

/**
 * Wires the call session controller to the app's realtime context — a filling,
 * beside realtime-provider.tsx, so nothing under components/ imports from app/.
 *
 * The session's deps are ref-reads (the same stateRef pattern the realtime
 * provider itself uses): handlers registered once must never close over a
 * stale conversations array. acquireSocket() is ref-counted, so this second
 * consumer is safe beside the provider's own.
 */
export function CallProvider() {
  const { viewerId, viewerUsername, conversations } = useRealtime();
  const stateRef = useRef({ viewerId, viewerUsername, conversations });
  useEffect(() => {
    stateRef.current = { viewerId, viewerUsername, conversations };
  });

  useEffect(() => {
    const socket = acquireSocket();
    const detach = attachCallSession(socket, {
      getViewerId: () => stateRef.current.viewerId,
      getConversations: () => stateRef.current.conversations,
    });
    return () => {
      detach();
      releaseSocket();
    };
  }, []);

  // memo'd: context churn re-renders this provider, not the call UI.
  return <CallRoot />;
}
