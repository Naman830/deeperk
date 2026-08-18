"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { FormError } from "@/components/features/shell/form-error";
import { apiPost, GENERIC_ERROR } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Open-or-create a DM and go to it (Docs/chat/chat.md §2.2).
 *
 * This is the one chat component that lives in components/features/, and the
 * reason is concrete rather than speculative: it is imported by
 * app/(app)/(messaging)/u/[username]/page.tsx (a server component) *and* by
 * components/features/search/user-search-results.tsx — and a file under
 * components/ must never import from app/.
 *
 * Takes a username rather than a user id because no user id is exposed to the
 * browser anywhere in this app; the server resolves it in the same lookup it
 * needs for the discoverable gate.
 */
export function MessageButton({
  username,
  size = "lg",
  iconOnly = false,
  className,
}: {
  username: string;
  size?: "sm" | "lg" | "icon-sm";
  iconOnly?: boolean;
  className?: string;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function start() {
    setError(undefined);
    setStarting(true);
    const res = await apiPost<{ conversationId: string }>("/api/conversations/direct", { username });
    setStarting(false);
    if (!res.ok) {
      // Inline, not a toast: the button is still on screen, so this is the
      // control the user would act on. Covers both the non-committal
      // "User not found" for a hidden account and the 20/hour DM cap.
      setError(res.data.error ?? GENERIC_ERROR);
      return;
    }
    router.push(`/chats/${res.data.conversationId}`);
  }

  if (iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Message @${username}`}
            disabled={starting}
            onClick={start}
            className={className}
          >
            <MessageSquare />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Message</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className={cn("flex flex-col items-center gap-2", className)}>
      <Button size={size} disabled={starting} onClick={start}>
        <MessageSquare /> {starting ? "Opening…" : "Message"}
      </Button>
      <FormError>{error}</FormError>
    </div>
  );
}
