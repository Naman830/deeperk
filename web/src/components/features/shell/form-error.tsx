import { cn } from "@/lib/utils";

/**
 * The one way this app renders an inline error.
 *
 * Channel rule (there were three competing ones, with none written down):
 *  1. INLINE, next to the control — the user can fix it by editing that control:
 *     validation, wrong password, taken username, bad OTP. Use this component.
 *  2. REGION state — a whole region has nothing to show and why: use EmptyState,
 *     not red text (e.g. search hitting its rate limit).
 *  3. TOAST — the action finished and the form or dialog it came from is gone or
 *     unchanged.
 * Never two channels for one failure.
 *
 * role="alert" so the message is announced; the hand-rolled <p> tags this
 * replaces were silent to screen readers.
 */
export function FormError({ children, className }: { children?: React.ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={cn("text-destructive text-sm", className)}>
      {children}
    </p>
  );
}
