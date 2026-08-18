"use client";

import { TriangleAlert } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Button } from "@/components/ui/button";

// Scoped to (messaging) rather than left to (app)/error.tsx so a thread that
// fails to load keeps the conversation column on screen — the user can pick a
// different chat instead of losing the whole shell.
//
// An error boundary is a client boundary and never flushes response headers, so
// unlike a loading.tsx this does NOT interfere with the segment's 404.
//
// unstable_retry(), not reset(): reset only re-renders, which for a failed DB
// read fails again instantly. (Next 16.2.0; the prefix means this needs
// renaming at the next major.)
export default function MessagingError({
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
        title="Couldn't load this conversation"
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
