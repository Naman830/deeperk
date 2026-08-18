import { useMemo, useState } from "react";
import { Check, Search, Users } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@/lib/chat/types";

/**
 * Pick one conversation from the sidebar's list.
 *
 * Promoted out of the route folder because it has two importers already — the
 * forward dialog under chats/[conversationId], and (later) share-to-chat — and
 * the repo's rule is that a component moves the moment one importer lives
 * outside its subtree. It is a *slot* by that rule's own test: it takes only
 * props, and knows no routes, endpoints or copy of its own.
 */
export function ConversationPicker({
  conversations,
  selectedId,
  onSelect,
  excludeId,
}: {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (conversationId: string) => void;
  /** Usually the conversation being forwarded FROM. */
  excludeId?: string;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    return conversations
      .filter((item) => item.id !== excludeId)
      .filter((item) => (term ? titleOf(item).toLowerCase().includes(term) : true));
  }, [conversations, excludeId, query]);

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="relative">
        <Search size={15} className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
          className="pl-8"
        />
      </div>

      {filtered.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">No chats match that.</p>
      ) : (
        <ul className="scroll-thin max-h-72 overflow-y-auto">
          {filtered.map((item) => {
            const selected = item.id === selectedId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => onSelect(item.id)}
                  aria-pressed={selected}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                    selected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                >
                  {item.type === "GROUP" ? (
                    <Avatar className="size-9">
                      {item.avatarUrl && <AvatarImage src={item.avatarUrl} alt="" />}
                      <AvatarFallback className="bg-primary/15 text-primary">
                        <Users size={15} />
                      </AvatarFallback>
                    </Avatar>
                  ) : (
                    <UserAvatar
                      src={item.otherUser?.avatarUrl ?? null}
                      firstName={item.otherUser?.firstName}
                      lastName={item.otherUser?.lastName}
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm">{titleOf(item)}</span>
                  {selected && <Check size={16} className="text-primary shrink-0" />}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function titleOf(conversation: ConversationSummary): string {
  if (conversation.type === "GROUP") return conversation.name ?? "Group";
  const other = conversation.otherUser;
  if (!other) return "Conversation";
  return `${other.firstName} ${other.lastName ?? ""}`.trim() || `@${other.displayUsername}`;
}
