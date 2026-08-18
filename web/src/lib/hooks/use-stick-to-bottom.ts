"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Message-list scroll behaviour.
 *
 * Deliberately NOT flex-col-reverse. That's the reflexive answer and it's wrong
 * here: it inverts wheel direction in some engines, confuses scrollIntoView, and
 * reverses DOM reading order against the <ol>, which then contradicts the
 * accessible semantics.
 *
 * "Pinned" is a ref, not state — it's read on every scroll event, and storing it
 * would re-render the whole thread on every frame of a scroll.
 */
const PIN_THRESHOLD_PX = 80;

export function useStickToBottom(conversationId: string, messageCount: number) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const prependRef = useRef<{ height: number; top: number } | null>(null);
  const [prependToken, setPrependToken] = useState(0);
  const [isPinned, setIsPinned] = useState(true);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_THRESHOLD_PX;
    pinnedRef.current = pinned;
    // Only re-render when the boolean actually flips, so the jump-to-latest
    // affordance can appear without every scroll frame costing a render.
    setIsPinned((current) => (current === pinned ? current : pinned));
  }, []);

  const stickToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setIsPinned(true);
  }, []);

  // Layout effect, not effect: a plain effect paints at the top of the thread
  // first and then jumps, which is visible.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    pinnedRef.current = true;
    setIsPinned(true);
  }, [conversationId]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messageCount]);

  // Restore the exact reading position after older messages are prepended.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const snapshot = prependRef.current;
    if (!element || !snapshot || prependToken === 0) return;
    element.scrollTop = snapshot.top + (element.scrollHeight - snapshot.height);
    prependRef.current = null;
  }, [prependToken]);

  /** Call synchronously *before* prepending older messages to state. */
  const captureBeforePrepend = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    prependRef.current = { height: element.scrollHeight, top: element.scrollTop };
    setPrependToken((token) => token + 1);
  }, []);

  // Media has no intrinsic size in the schema (mediaSize is bytes, not
  // dimensions), so bubbles grow when images finish loading. Without this the
  // view drifts away from the newest message exactly when it matters.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
    for (const child of Array.from(element.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [conversationId]);

  return { scrollRef, onScroll, isPinned, stickToBottom, captureBeforePrepend };
}
