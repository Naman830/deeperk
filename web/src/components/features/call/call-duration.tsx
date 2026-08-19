import { useSecondTick } from "@/lib/hooks/use-second-tick";
import { formatCallDuration } from "@/lib/call/call-message";

// No "use client": rendered inside call-provider's boundary.

/**
 * The ONLY subscriber to use-second-tick — mounted twice (surface header,
 * minimized tile) so nothing else re-renders once a second.
 */
export function CallDuration({ startedAt, className }: { startedAt: number | null; className?: string }) {
  const now = useSecondTick();
  if (startedAt === null) return null;
  return <span className={className}>{formatCallDuration((now - startedAt) / 1000)}</span>;
}
