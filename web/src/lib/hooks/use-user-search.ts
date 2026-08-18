import { useEffect, useState } from "react";
import { useDebouncedValue } from "@/lib/hooks/use-debounced-value";

export type SearchResult = {
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
};

export const MIN_SEARCH_LENGTH = 2;

// Keyed by the query it belongs to, so "is this stale?" is a comparison rather
// than a second piece of state that has to be kept in sync — and so nothing
// setStates synchronously inside the effect, which React 19's
// react-hooks/set-state-in-effect rule flags.
type Outcome = { query: string; limited: boolean; results: SearchResult[] };

/**
 * Docs/user/search.md §2 — 300ms debounce, no request under 2 characters.
 *
 * Extracted from UserSearchResults so the group member picker shares one query
 * path with it rather than growing a second, subtly different copy.
 */
export function useUserSearch(query: string) {
  const debouncedQuery = useDebouncedValue(query.trim(), 300);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const active = debouncedQuery.length >= MIN_SEARCH_LENGTH;
  // Derived, not stored: anything not yet answered for this exact query is loading.
  const loading = active && outcome?.query !== debouncedQuery;

  useEffect(() => {
    // §4: under 2 characters no request is sent at all — not sent-then-ignored.
    if (debouncedQuery.length < MIN_SEARCH_LENGTH) return;

    // `ignore` drops out-of-order responses.
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

  return {
    active,
    loading,
    limited: outcome?.limited ?? false,
    results: outcome && outcome.query === debouncedQuery ? outcome.results : [],
  };
}
