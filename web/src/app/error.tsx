"use client";

import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

// Covers the routes outside the (app) group — /, /login, /signup and
// /login/forgot-password. Those have no shell, so this renders standalone.
export default function RootError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <main className="bg-background grid min-h-dvh place-items-center px-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <TriangleAlert size={28} className="text-muted-foreground opacity-60" />
        <div>
          <p className="text-sm font-medium">Something went wrong</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-xs text-sm">
            That didn&apos;t load. It&apos;s usually temporary — try again.
          </p>
        </div>
        <Button onClick={() => unstable_retry()}>Try again</Button>
        {error.digest && <span className="text-muted-foreground text-xs">Reference: {error.digest}</span>}
      </div>
    </main>
  );
}
