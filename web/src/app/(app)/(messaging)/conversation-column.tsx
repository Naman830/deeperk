"use client";

import { useState } from "react";
import { ListColumn } from "@/components/features/shell/list-column";
import { UserSearchResults, MIN_SEARCH_LENGTH } from "@/components/features/search/user-search-results";
import { UserSearchInput } from "@/components/features/search/user-search-input";
import { ConversationList } from "./conversation-list";
import { NewGroupButton } from "./new-group-button";

// The sketch's middle column: a search field above the conversation list. Typing
// 2+ characters swaps the list for people search (Docs/user/search.md), so
// finding someone new and reopening an existing chat share one control.
export function ConversationColumn() {
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;

  return (
    <ListColumn
      title="Chats"
      action={<NewGroupButton />}
      toolbar={<UserSearchInput value={query} onChange={setQuery} />}
    >
      {searching ? <UserSearchResults query={query} /> : <ConversationList />}
    </ListColumn>
  );
}
