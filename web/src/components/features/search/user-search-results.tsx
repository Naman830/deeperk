"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { SearchX, Timer } from "lucide-react";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export type SearchResult = {
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
};

export const MIN_SEARCH_LENGTH = 2;

// Keyed by the query it belongs to, so "is this stale?" is a comparison rather
// than a second piece of state that has to be kept in sync.
type Outcome = { query: string; limited: boolean; results: SearchResult[] };

/**
 * Docs/user/search.md §2 — 300ms debounce, no request under 2 characters, 10
 * results max, each row linking to /u/[username].
 */
export function UserSearchResults({ query }: { query: string }) {
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const active = debouncedQuery.length >= MIN_SEARCH_LENGTH;
  // Derived, not stored: anything not yet answered for this exact query is loading.
  const loading = active && outcome?.query !== debouncedQuery;

  useEffect(() => {
    // §4: under 2 characters no request is sent at all — not sent-then-ignored.
    if (debouncedQuery.length < MIN_SEARCH_LENGTH) return;

    // `ignore` drops out-of-order responses — same guard as the signup form's
    // username availability check.
    let ignore = false;

    (async () => {
      try {
        const res = await fetch(`/api/users/search?q=${encodeURIComponent(debouncedQuery)}`);
        if (ignore) return;
        if (res.status === 429) {
          setOutcome({ query: debouncedQuery, limited: true, results: [] });
          return;
        }
        const data = await res.json().catch(() => ({ results: [] }));
        setOutcome({ query: debouncedQuery, limited: false, results: data.results ?? [] });
      } catch {
        if (!ignore) setOutcome({ query: debouncedQuery, limited: false, results: [] });
      }
    })();

    return () => {
      ignore = true;
    };
  }, [debouncedQuery]);

  if (!active) return null;

  if (loading) {
    return (
      <div className="flex flex-col gap-1 py-2">
        {[0, 1, 2].map((row) => (
          <div key={row} className="flex items-center gap-3 px-2 py-2">
            <Skeleton className="size-10 rounded-full" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (outcome?.limited) {
    // Region state, not a form error — same treatment as "No one found" directly
    // below, rather than a stray line of red text. See FormError's channel rule.
    return <EmptyState icon={<Timer size={28} />} title="Too many searches" description="Slow down for a moment, then try again." />;
  }

  if (!outcome || outcome.results.length === 0) {
    // §5: identical wording whether there were zero matches or every match was
    // hidden by `discoverable` — a search must never confirm someone exists.
    return <EmptyState icon={<SearchX size={28} />} title="No one found" description="Check the spelling, or try a different username." />;
  }

  return (
    <ul className="flex flex-col">
      {outcome.results.map((result) => (
        <li key={result.username}>
          <Link href={`/u/${result.username}`} className="hover:bg-accent flex items-center gap-3 rounded-lg px-2 py-2 transition-colors">
            <UserAvatar src={result.avatarUrl} firstName={result.firstName} lastName={result.lastName} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {result.firstName} {result.lastName ?? ""}
              </span>
              <span className="text-muted-foreground block truncate text-xs">@{result.displayUsername}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
