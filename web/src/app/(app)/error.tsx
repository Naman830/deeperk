"use client";

import { TriangleAlert } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Button } from "@/components/ui/button";

// Nested inside (app)/layout.tsx, so the nav rail survives the crash and the user
// can navigate away instead of hitting a dead end. This is the boundary that
// matters: everything under it awaits a DB query.
//
// unstable_retry(), not reset() — reset only re-renders, which for a failed
// getOwnProfile/getPublicProfile would fail again instantly. unstable_retry
// re-fetches. (Added in Next 16.2.0; the `unstable_` prefix means this needs
// renaming at the next major.)
export default function AppError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <MainPane centered>
      <EmptyState
        icon={<TriangleAlert size={28} />}
        title="Something went wrong"
        description="That didn't load. It's usually temporary — try again."
        action={
          <div className="flex flex-col items-center gap-2">
            <Button onClick={() => unstable_retry()}>Try again</Button>
            {error.digest && <span className="text-muted-foreground text-xs">Reference: {error.digest}</span>}
          </div>
        }
      />
    </MainPane>
  );
}
