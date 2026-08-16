"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { UserSearchResults, MIN_SEARCH_LENGTH } from "@/components/features/search/user-search-results";
import { UserSearchInput } from "@/components/features/search/user-search-input";
import { EmptyState } from "@/components/features/shell/empty-state";

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;

  return (
    <main className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 px-4 py-6">
      <UserSearchInput value={query} onChange={setQuery} size="lg" autoFocus />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {searching ? (
          <UserSearchResults query={query} />
        ) : (
          <EmptyState icon={<Search size={28} />} title="Find people" description="Type at least 2 characters of a username." />
        )}
      </div>
    </main>
  );
}
