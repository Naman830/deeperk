import { PhoneOff } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { listCallHistory } from "@/lib/call/history";
import { EmptyState } from "@/components/features/shell/empty-state";
import { CallHistoryPager } from "./call-history-pager";

// Async server component rendered inside the layout's ListColumn — on mobile
// /calls shows the list, so it cannot live in page.tsx (the detail pane).
export async function CallHistoryList() {
  const session = await getSession();
  if (!session) return null; // (app)/layout already redirected — type guard only

  const { entries, nextCursor, hasMore } = await listCallHistory(session.user.id);

  if (entries.length === 0) {
    return (
      <EmptyState icon={<PhoneOff size={28} />} title="No calls yet" description="Your call history will show up here." />
    );
  }

  // Keyed on page 1's tail cursor: CallsRefresher's router.refresh() re-seeds
  // these props, and a moved page boundary must drop the pager's loaded extras
  // (the key-reset idiom) — while a refresh that only updates row contents
  // keeps them.
  return (
    <CallHistoryPager
      key={nextCursor ?? "complete"}
      initialEntries={entries}
      initialCursor={nextCursor}
      initialHasMore={hasMore}
    />
  );
}
