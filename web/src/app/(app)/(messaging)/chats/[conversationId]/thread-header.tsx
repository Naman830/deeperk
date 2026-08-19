import Link from "next/link";
import { ArrowLeft, BellOff, Pin, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CallButtons } from "@/components/features/call/call-buttons";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useNow, isMuted } from "@/lib/hooks/use-now";
import type { ChatMember, ConversationDetail } from "@/lib/chat/types";
import { GroupSettingsDialog } from "./group-settings-dialog";
import { ConversationMenu } from "./conversation-menu";
import { useRealtime } from "../../../realtime-provider";

// No "use client": rendered from chat-thread.tsx.

export function ThreadHeader({
  conversation,
  other,
  presenceOnline,
  typingNames,
  headingRef,
  viewerId,
  onOpenSearch,
  onOpenMedia,
}: {
  conversation: ConversationDetail;
  other: ChatMember | undefined;
  presenceOnline?: boolean;
  typingNames: string[];
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  viewerId: string;
  onOpenSearch: () => void;
  onOpenMedia: () => void;
}) {
  const { conversations } = useRealtime();
  const now = useNow();
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

  const summary = conversations.find((item) => item.id === conversation.id);
  const pinned = (summary?.pinnedAt ?? conversation.pinnedAt) !== null;
  const mutedUntil = summary?.mutedUntil ?? conversation.mutedUntil;
  const muted = isMuted(mutedUntil, now);

  // Typing takes the subtitle while it lasts — it is the most current thing
  // that can be said about the other person, and it is what every reference
  // messenger shows there.
  const subtitle =
    typingNames.length > 0
      ? typingNames.length === 1
        ? `${typingNames[0]} is typing…`
        : "Several people are typing…"
      : isGroup
        ? `${conversation.members.length} member${conversation.members.length === 1 ? "" : "s"}`
        : showsPresence
          ? online
            ? "Online"
            : "Offline"
          : `@${other?.displayUsername ?? ""}`;

  return (
    <header className="bg-background/80 flex h-14 shrink-0 items-center gap-2 border-b px-2 backdrop-blur md:px-4">
      <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
        <Link href="/chats" aria-label="Back to chats">
          <ArrowLeft />
        </Link>
      </Button>

      {isGroup ? (
        <Avatar className="size-9">
          {conversation.avatarUrl && <AvatarImage src={conversation.avatarUrl} alt="" />}
          <AvatarFallback className="bg-primary/15 text-primary">
            <Users size={15} />
          </AvatarFallback>
        </Avatar>
      ) : (
        <UserAvatar
          src={other?.avatarUrl ?? null}
          firstName={other?.firstName}
          lastName={other?.lastName}
          isOnline={showsPresence ? online : undefined}
        />
      )}

      <div className="min-w-0 flex-1">
        <h2 ref={headingRef} tabIndex={-1} className="flex items-center gap-1.5 truncate text-sm font-medium outline-none">
          <span className="truncate">{title}</span>
          {pinned && <Pin size={12} className="text-muted-foreground shrink-0" aria-label="Pinned" />}
          {muted && <BellOff size={12} className="text-muted-foreground shrink-0" aria-label="Muted" />}
        </h2>
        <p
          className={
            typingNames.length > 0
              ? "text-primary truncate text-xs italic"
              : "text-muted-foreground truncate text-xs"
          }
        >
          {subtitle}
        </p>
      </div>

      {!isGroup && other && (
        <Button asChild variant="ghost" size="sm" className="hidden @md/pane:inline-flex">
          <Link href={`/u/${other.username}`}>View profile</Link>
        </Button>
      )}
      {isGroup && <GroupSettingsDialog conversation={conversation} viewerId={viewerId} />}

      <CallButtons conversationId={conversation.id} />

      <ConversationMenu
        conversation={conversation}
        otherUsername={other?.username}
        onOpenSearch={onOpenSearch}
        onOpenMedia={onOpenMedia}
      />
    </header>
  );
}
