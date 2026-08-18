import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { MESSAGE_SEARCH_MIN_LENGTH } from "@/lib/validation/chat";
import type { ChatMember, ChatMessage } from "@/lib/chat/types";

// No "use client": rendered from chat-thread.tsx.

type Outcome = { query: string; messages: ChatMessage[] };

/**
 * In-conversation message search.
 *
 * The outcome is keyed by the query it answered, so "loading" is derived rather
 * than stored — no setState runs synchronously inside the effect, which React
 * 19's set-state-in-effect rule forbids, and the keyed form is immune to
 * out-of-order responses on its own. Same shape as UserSearchResults.
 */
export function ThreadSearch({
  conversationId,
  membersById,
  viewerId,
  onJump,
  onClose,
}: {
  conversationId: string;
  membersById: Map<string, ChatMember>;
  viewerId: string;
  onJump: (messageId: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const [outcome, setOutcome] = useState<Outcome>({ query: "", messages: [] });

  useEffect(() => {
    const term = debounced.trim();
    if (term.length < MESSAGE_SEARCH_MIN_LENGTH) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(
          `/api/conversations/${conversationId}/messages/search?q=${encodeURIComponent(term)}`,
        );
        if (!response.ok || cancelled) return;
        const data = (await response.json()) as { messages: ChatMessage[] };
        if (!cancelled) setOutcome({ query: debounced, messages: data.messages ?? [] });
      } catch {
        // Offline. The next keystroke retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conversationId, debounced]);

  const term = debounced.trim();
  const tooShort = term.length < MESSAGE_SEARCH_MIN_LENGTH;
  const loading = !tooShort && outcome.query !== debounced;

  return (
    <div className="bg-background flex max-h-72 shrink-0 flex-col border-b">
      <div className="flex items-center gap-2 p-2">
        <div className="relative flex-1">
          <Search size={15} className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              // Stops chat-thread's Esc handler closing the whole thread when
              // the user only meant to close the search bar.
              event.stopPropagation();
              onClose();
            }}
            placeholder="Search in this chat"
            aria-label="Search in this chat"
            className="pl-8"
          />
        </div>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Close search" onClick={onClose}>
          <X />
        </Button>
      </div>

      {!tooShort && (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {loading ? (
            <p className="text-muted-foreground py-3 text-center text-xs">Searching…</p>
          ) : outcome.messages.length === 0 ? (
            <p className="text-muted-foreground py-3 text-center text-xs">No messages found.</p>
          ) : (
            <ul>
              {outcome.messages.map((message) => {
                const sender = membersById.get(message.senderId);
                return (
                  <li key={message.id}>
                    <button
                      type="button"
                      onClick={() => onJump(message.id)}
                      className="hover:bg-accent/50 flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="truncate text-xs font-medium">
                          {message.senderId === viewerId
                            ? "You"
                            : `${sender?.firstName ?? "Unknown"} ${sender?.lastName ?? ""}`.trim()}
                        </span>
                        <time
                          dateTime={message.createdAt}
                          suppressHydrationWarning
                          className="text-muted-foreground shrink-0 text-[10px]"
                        >
                          {new Date(message.createdAt).toLocaleDateString()}
                        </time>
                      </span>
                      <span className="text-muted-foreground line-clamp-2 text-xs">{message.body}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
