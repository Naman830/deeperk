import { memo, useSyncExternalStore } from "react";
import { getCallState, getServerCallState, subscribeCall } from "@/lib/call/call-store";
import { CallSurface } from "./call-surface";
import { IncomingCallModal } from "./incoming-call-modal";
import { MinimizedTile } from "./minimized-tile";

// No "use client": rendered inside call-provider's boundary.

/**
 * The overlay root — the ONE subscriber to the full call state. memo'd so
 * CallProvider's re-renders on realtime-context churn stop here; the store
 * subscription is the only thing that repaints the call UI.
 */
export const CallRoot = memo(function CallRoot() {
  const state = useSyncExternalStore(subscribeCall, getCallState, getServerCallState);
  if (state.phase === "idle") return null;
  if (state.phase === "incoming") return <IncomingCallModal state={state} />;
  if (state.minimized) return <MinimizedTile state={state} />;
  return <CallSurface state={state} />;
});
