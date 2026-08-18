import Link from "next/link";
import { SearchX, Timer } from "lucide-react";
import { useUserSearch, MIN_SEARCH_LENGTH, type SearchResult } from "@/lib/hooks/use-user-search";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { MessageButton } from "@/components/features/messaging/message-button";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export { MIN_SEARCH_LENGTH };
export type { SearchResult };

/**
 * Docs/user/search.md §2 — 300ms debounce, no request under 2 characters, 10
 * results max, each row linking to /u/[username], plus a direct Message action
 * (Docs/chat/chat.md §2.2's "click Message on a search result").
 */
export function UserSearchResults({ query }: { query: string }) {
  const { active, loading, limited, results } = useUserSearch(query);

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

  if (limited) {
    // Region state, not a form error — same treatment as "No one found" directly
    // below, rather than a stray line of red text. See FormError's channel rule.
    return <EmptyState icon={<Timer size={28} />} title="Too many searches" description="Slow down for a moment, then try again." />;
  }

  if (results.length === 0) {
    // §5: identical wording whether there were zero matches or every match was
    // hidden by `discoverable` — a search must never confirm someone exists.
    return <EmptyState icon={<SearchX size={28} />} title="No one found" description="Check the spelling, or try a different username." />;
  }

  return (
    <ul className="flex flex-col">
      {results.map((result) => (
        // Stretched link: the <Link>'s ::after covers the row, so the whole row
        // is clickable without nesting the Message <button> inside an <a>.
        <li key={result.username} className="hover:bg-accent relative flex items-center gap-3 rounded-lg px-2 py-2 transition-colors">
          <Link href={`/u/${result.username}`} className="flex min-w-0 flex-1 items-center gap-3 after:absolute after:inset-0 after:content-['']">
            <UserAvatar src={result.avatarUrl} firstName={result.firstName} lastName={result.lastName} />
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">
                {result.firstName} {result.lastName ?? ""}
              </span>
              <span className="text-muted-foreground block truncate text-xs">@{result.displayUsername}</span>
            </span>
          </Link>
          {/* Always visible, never hover-revealed: an opacity-0 control is
              either an invisible mouse target or unreachable by keyboard. */}
          <MessageButton username={result.username} iconOnly className="relative z-10 shrink-0" />
        </li>
      ))}
    </ul>
  );
}
