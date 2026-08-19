import { Phone, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { avatarUrl } from "@/lib/avatar-url";
import { acceptCall, declineCall } from "@/lib/call/session";
import type { CallState } from "@/lib/call/call-store";

// No "use client": rendered inside call-provider's boundary.

/**
 * Plain divs, deliberately NOT the Dialog primitive: Radix's focus trap and
 * Esc-to-close semantics are wrong for a call surface — Esc must never
 * silently decline a call, and nothing behind it needs trapping.
 */
export function IncomingCallModal({ state }: { state: CallState }) {
  const caller = state.caller;
  if (!caller) return null;
  const kindWord = state.kind === "VIDEO" ? "video" : "audio";
  const callerName = `${caller.firstName} ${caller.lastName ?? ""}`.trim();

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`Incoming ${kindWord} call from ${callerName}`}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
    >
      <div className="bg-card flex w-full max-w-sm flex-col items-center gap-5 rounded-2xl border p-6">
        <UserAvatar
          src={avatarUrl(caller.avatarPublicId, 256)}
          firstName={caller.firstName}
          lastName={caller.lastName}
          size="xl"
        />
        <div className="text-center">
          <p className="text-lg font-semibold">{callerName}</p>
          <p className="text-muted-foreground mt-0.5 text-sm">
            {state.conversationType === "GROUP" && state.conversationName
              ? `Incoming ${kindWord} call · ${state.conversationName}`
              : `Incoming ${kindWord} call`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="destructive" size="lg" onClick={declineCall}>
            <PhoneOff /> Decline
          </Button>
          {/* autoFocus: Enter answers — the one action an incoming ring is for. */}
          <Button autoFocus size="lg" onClick={() => void acceptCall()}>
            <Phone /> Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
