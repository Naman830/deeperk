import { Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@/lib/chat/types";

// No "use client": every importer is already inside the client boundary that
// conversation-column.tsx opens.

type ConversationAvatarProps = {
  conversation: ConversationSummary;
  /** Live presence for the DM counterpart, if the socket has heard any. */
  isOnline?: boolean;
  size?: "sm" | "md";
  className?: string;
};

export function ConversationAvatar({ conversation, isOnline, size = "md", className }: ConversationAvatarProps) {
  if (conversation.type === "DIRECT") {
    const other = conversation.otherUser;
    return (
      <UserAvatar
        src={other?.avatarUrl ?? null}
        firstName={other?.firstName}
        lastName={other?.lastName}
        size={size}
        // undefined renders no dot at all, which is the privacy-hidden state.
        // `isOnline: false` and "hidden" are different things — branch on key
        // presence, never on truthiness.
        isOnline={other && "isOnline" in other ? (isOnline ?? other.isOnline) : undefined}
        className={className}
      />
    );
  }

  const box = size === "sm" ? "size-8" : "size-10";
  return (
    <Avatar className={cn(box, className)}>
      {conversation.avatarUrl && <AvatarImage src={conversation.avatarUrl} alt="" />}
      <AvatarFallback className="bg-primary/15 text-primary">
        <Users size={size === "sm" ? 14 : 18} />
      </AvatarFallback>
    </Avatar>
  );
}
