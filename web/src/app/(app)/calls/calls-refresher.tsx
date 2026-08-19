"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { getCallPhase, getServerCallPhase, subscribeCall } from "@/lib/call/call-store";

// Mounted by the /calls layout only: when a call reaches a terminal state
// (any phase → idle) the server has already written its history row, so a
// refresh makes it appear without a reload.
export function CallsRefresher() {
  const router = useRouter();
  const phase = useSyncExternalStore(subscribeCall, getCallPhase, getServerCallPhase);
  const previous = useRef(phase);

  useEffect(() => {
    const was = previous.current;
    previous.current = phase;
    if (was !== "idle" && phase === "idle") router.refresh();
  }, [phase, router]);

  return null;
}
