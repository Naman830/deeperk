"use client";

import { useState } from "react";
import { MessagesSquare, Search } from "lucide-react";
import { ListColumn } from "./list-column";
import { UserSearchResults, MIN_SEARCH_LENGTH } from "./user-search-results";
import { EmptyState } from "./empty-state";
import { Input } from "@/components/ui/input";

// The sketch's middle column: a search field above the conversation list. Typing
// 2+ characters swaps the list for people search (Docs/user/search.md), so
// finding someone new and reopening an existing chat share one control.
export function ConversationColumn() {
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;

  return (
    <ListColumn
      title="Chats"
      toolbar={
        <div className="relative">
          <Search size={15} className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search people by username"
            aria-label="Search people by username"
            className="h-9 pl-8"
          />
        </div>
      }
    >
      {searching ? (
        <UserSearchResults query={query} />
      ) : (
        <EmptyState
          icon={<MessagesSquare size={28} />}
          title="No conversations yet"
          description="Search for someone by username to start chatting."
        />
      )}
    </ListColumn>
  );
}
