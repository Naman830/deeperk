"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { UserSearchResults, MIN_SEARCH_LENGTH } from "@/components/features/search/user-search-results";
import { UserSearchInput } from "@/components/features/search/user-search-input";
import { EmptyState } from "@/components/features/shell/empty-state";

export function SearchPanel() {
  const [query, setQuery] = useState("");
  const searching = query.trim().length >= MIN_SEARCH_LENGTH;

  return (
    <main className="mx-auto flex h-full w-full max-w-xl flex-col gap-4 px-4 py-6">
      {/* /search sits outside the (messaging) group, so it has no list column to
          fall back to. Without this the only way back on a phone is the browser
          button — the same mobile-only back link SettingsPane already uses. */}
      <Button asChild variant="ghost" size="sm" className="text-muted-foreground -ml-2 self-start md:hidden">
        <Link href="/chats">
          <ArrowLeft /> Chats
        </Link>
      </Button>

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
