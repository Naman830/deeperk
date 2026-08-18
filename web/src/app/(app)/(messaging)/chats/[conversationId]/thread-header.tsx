import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Users } from "lucide-react";
import type { ChatMember, ConversationDetail } from "@/lib/chat/types";
import { GroupSettingsDialog } from "./group-settings-dialog";

// No "use client": rendered from chat-thread.tsx.

export function ThreadHeader({
  conversation,
  other,
  presenceOnline,
  headingRef,
  viewerId,
}: {
  conversation: ConversationDetail;
  other: ChatMember | undefined;
  presenceOnline?: boolean;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  viewerId: string;
}) {
  const isGroup = conversation.type === "GROUP";
  const title = isGroup
    ? (conversation.name ?? "Group")
    : other
      ? `${other.firstName} ${other.lastName ?? ""}`.trim() || `@${other.displayUsername}`
      : "Conversation";

  // Key presence, not truthiness: the API omits isOnline entirely when the
  // other person's privacy hides it, and "hidden" is not "offline".
  const showsPresence = other ? "isOnline" in other : false;
  const online = presenceOnline ?? other?.isOnline ?? false;

  const subtitle = isGroup
    ? `${conversation.members.length} member${conversation.members.length === 1 ? "" : "s"}`
    : showsPresence
      ? online
        ? "Online"
        : "Offline"
      : `@${other?.displayUsername ?? ""}`;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-5">
      <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
        <Link href="/chats" aria-label="Back to chats">
          <ArrowLeft />
        </Link>
      </Button>

      {isGroup ? (
        <Avatar className="size-8">
          {conversation.avatarUrl && <AvatarImage src={conversation.avatarUrl} alt="" />}
          <AvatarFallback className="bg-primary/15 text-primary">
            <Users size={14} />
          </AvatarFallback>
        </Avatar>
      ) : (
        <UserAvatar
          src={other?.avatarUrl ?? null}
          firstName={other?.firstName}
          lastName={other?.lastName}
          size="sm"
          isOnline={showsPresence ? online : undefined}
        />
      )}

      <div className="min-w-0 flex-1">
        <h2 ref={headingRef} tabIndex={-1} className="truncate text-sm font-medium outline-none">
          {title}
        </h2>
        <p className="text-muted-foreground truncate text-xs">{subtitle}</p>
      </div>

      {isGroup ? (
        <GroupSettingsDialog conversation={conversation} viewerId={viewerId} />
      ) : (
        other && (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/u/${other.username}`}>View profile</Link>
          </Button>
        )
      )}
    </header>
  );
}
