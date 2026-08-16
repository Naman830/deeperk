"use client";

import { useState } from "react";
import { Search } from "lucide-react";
import { UserSearchResults, MIN_SEARCH_LENGTH } from "@/components/app/user-search-results";
import { EmptyState } from "@/components/app/empty-state";
import { Input } from "@/components/ui/input";

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;

  return (
    <main className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 px-4 py-6">
      <div className="relative">
        <Search size={16} className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
        <Input
          type="search"
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search people by username"
          aria-label="Search people by username"
          className="h-11 pl-9"
        />
      </div>

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
