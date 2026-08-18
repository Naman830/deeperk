import { X } from "lucide-react";
import { UserSearchInput } from "@/components/features/search/user-search-input";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useUserSearch, type SearchResult } from "@/lib/hooks/use-user-search";
import { cn } from "@/lib/utils";

// No "use client": only ever rendered from a dialog that is already inside the
// client boundary. Not promoted to components/features/ either — both importers
// (group create and group settings) live inside (messaging)/.

export type PickedUser = Pick<SearchResult, "username" | "displayUsername" | "firstName" | "lastName" | "avatarUrl">;

export function MemberPicker({
  query,
  onQueryChange,
  selected,
  onToggle,
  excludeUsernames = [],
  disabled = false,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  selected: PickedUser[];
  onToggle: (user: PickedUser) => void;
  excludeUsernames?: string[];
  disabled?: boolean;
}) {
  const { active, loading, limited, results } = useUserSearch(query);
  const selectedUsernames = new Set(selected.map((user) => user.username));
  const excluded = new Set(excludeUsernames);

  return (
    <div className="flex min-h-0 flex-col gap-3">
      {selected.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {selected.map((user) => (
            <li key={user.username}>
              <span className="bg-accent flex items-center gap-1 rounded-full py-0.5 pr-1 pl-2 text-xs">
                @{user.displayUsername}
                <button
                  type="button"
                  onClick={() => onToggle(user)}
                  aria-label={`Remove @${user.displayUsername}`}
                  className="hover:bg-background rounded-full p-0.5"
                >
                  <X size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      <UserSearchInput value={query} onChange={onQueryChange} autoFocus />

      <div className="scroll-thin -mx-1 max-h-64 min-h-0 flex-1 overflow-y-auto px-1">
        {!active && <p className="text-muted-foreground px-1 py-6 text-center text-xs">Search by username to add people.</p>}
        {active && loading && (
          <div className="flex flex-col gap-1 py-2">
            {[0, 1, 2].map((row) => (
              <div key={row} className="flex items-center gap-3 px-1 py-2">
                <Skeleton className="size-8 rounded-full" />
                <Skeleton className="h-3 w-28" />
              </div>
            ))}
          </div>
        )}
        {active && !loading && limited && (
          <p className="text-muted-foreground px-1 py-6 text-center text-xs">Too many searches. Slow down for a moment.</p>
        )}
        {active && !loading && !limited && results.length === 0 && (
          <p className="text-muted-foreground px-1 py-6 text-center text-xs">No one found.</p>
        )}
        {active &&
          !loading &&
          results.map((result) => {
            const isExcluded = excluded.has(result.username);
            const checked = selectedUsernames.has(result.username);
            return (
              <label
                key={result.username}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-1 py-2",
                  isExcluded ? "opacity-50" : "hover:bg-accent cursor-pointer",
                )}
              >
                <Checkbox
                  checked={isExcluded || checked}
                  disabled={disabled || isExcluded}
                  onCheckedChange={() => onToggle(result)}
                />
                <UserAvatar src={result.avatarUrl} firstName={result.firstName} lastName={result.lastName} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {result.firstName} {result.lastName ?? ""}
                  </span>
                  <span className="text-muted-foreground block truncate text-xs">@{result.displayUsername}</span>
                </span>
                {isExcluded && <span className="text-muted-foreground text-xs">Already in</span>}
              </label>
            );
          })}
      </div>
    </div>
  );
}
