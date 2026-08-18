import { usePathname } from "next/navigation";
import { MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/features/shell/empty-state";
import { useRealtime } from "../realtime-provider";
import { ConversationRow } from "./conversation-row";

// No "use client": conversation-column.tsx already opened the boundary, and
// this only ever renders from there.

export function ConversationList() {
  const pathname = usePathname();
  const { conversations, presence, typingIn, viewerId } = useRealtime();

  if (conversations.length === 0) {
    return (
      <EmptyState
        icon={<MessagesSquare size={28} />}
        title="No conversations yet"
        description="Search for someone by username to start chatting."
      />
    );
  }

  const activeId = pathname.startsWith("/chats/") ? pathname.slice("/chats/".length).split("/")[0] : null;

  return (
    <ul className="flex flex-col">
      {conversations.map((conversation) => {
        const otherId = conversation.otherUser?.id;
        return (
          <ConversationRow
            key={conversation.id}
            conversation={conversation}
            active={conversation.id === activeId}
            isOnline={otherId ? presence[otherId]?.isOnline : undefined}
            typingNames={typingIn(conversation.id)}
            viewerId={viewerId}
          />
        );
      })}
    </ul>
  );
}
