"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { CallHistoryEntry } from "@/lib/call/history";
import { CallRow } from "./call-row";

// Owns only the pages BEYOND the server-rendered first one (media-panel's
// load-more idiom — a button, not an IntersectionObserver, because ListColumn
// owns the scroll container). The parent keys this component on page 1's tail
// cursor, so a router.refresh() that moves the page boundary remounts it and
// drops the stale extras; refreshes that leave the boundary alone keep them.
export function CallHistoryPager({
  initialEntries,
  initialCursor,
  initialHasMore,
}: {
  initialEntries: CallHistoryEntry[];
  initialCursor: string | null;
  initialHasMore: boolean;
}) {
  const pathname = usePathname();
  const [extra, setExtra] = useState<CallHistoryEntry[]>([]);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const response = await fetch(`/api/calls?before=${encodeURIComponent(cursor)}`);
      if (!response.ok) return;
      const data = (await response.json()) as {
        entries: CallHistoryEntry[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      setExtra((current) => [...current, ...data.entries]);
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } finally {
      setLoadingMore(false);
    }
  }

  const entries = [...initialEntries, ...extra];

  return (
    <>
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <CallRow key={entry.id} entry={entry} active={pathname === `/calls/${entry.id}`} />
        ))}
      </ul>
      {hasMore && (
        <div className="pt-3 text-center">
          <Button type="button" variant="ghost" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </>
  );
}
