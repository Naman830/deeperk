import { useCallback, useEffect, useRef } from "react";

/**
 * typing:start / typing:stop with the 2-second pause from Docs/chat/chat.md §2.6.
 *
 * `bump()` fires once per burst, not once per keystroke — an emit per keypress
 * would be ~30/second per user, each fanned out to every member of the room,
 * which is its own amplification problem before it is a rate-limit problem.
 */
export function useTypingEmitter(conversationId: string, emit: (conversationId: string, typing: boolean) => void) {
  const activeRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emitRef = useRef(emit);
  useEffect(() => {
    emitRef.current = emit;
  });

  const stop = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!activeRef.current) return;
    activeRef.current = false;
    emitRef.current(conversationId, false);
  }, [conversationId]);

  const bump = useCallback(() => {
    if (!activeRef.current) {
      activeRef.current = true;
      emitRef.current(conversationId, true);
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(stop, 2000);
  }, [conversationId, stop]);

  // Switching conversation or unmounting must retract the indicator, or the
  // other side is left with a permanent "X is typing…".
  useEffect(() => stop, [conversationId, stop]);

  return { bump, stop };
}
