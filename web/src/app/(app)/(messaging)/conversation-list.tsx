import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { Archive, MessagesSquare } from "lucide-react";
import { EmptyState } from "@/components/features/shell/empty-state";
import { useRealtime } from "../realtime-provider";
import { ConversationRow } from "./conversation-row";

// No "use client": conversation-column.tsx already opened the boundary, and
// this only ever renders from there.

export function ConversationList() {
  const pathname = usePathname();
  const { conversations, presence, typingIn, viewerId } = useRealtime();
  const [showArchived, setShowArchived] = useState(false);

  // Archived chats are hidden behind one row rather than a separate route: the
  // list column is the only surface they belong on, and a /chats/archived page
  // would need its own layout for a list most people never open.
  const { visible, archivedCount } = useMemo(() => {
    const archived = conversations.filter((item) => item.archivedAt !== null);
    return {
      visible: showArchived ? archived : conversations.filter((item) => item.archivedAt === null),
      archivedCount: archived.length,
    };
  }, [conversations, showArchived]);

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
    <>
      {archivedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowArchived((current) => !current)}
          aria-expanded={showArchived}
          className="hover:bg-sidebar-accent/50 mb-1 flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors"
        >
          <span className="bg-muted text-muted-foreground grid size-9 shrink-0 place-items-center rounded-full">
            <Archive size={15} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {showArchived ? "Back to chats" : "Archived"}
          </span>
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums">{archivedCount}</span>
        </button>
      )}

      <ul className="flex flex-col">
          {visible.map((conversation) => {
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
    </>
  );
}
