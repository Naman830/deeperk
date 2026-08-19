"use client";

// Client leaf for the row timestamp: call-row is a server component, and the
// server's timezone is not the viewer's — same reason conversation-row formats
// its time on the client. useNow (minute tick) keeps the same-day check honest
// past midnight; a bare new Date() in render would go stale with nothing to
// re-render this row (it only re-renders on router.refresh()).

import { useNow } from "@/lib/hooks/use-now";

let timeFormat: Intl.DateTimeFormat | null = null;
let dateFormat: Intl.DateTimeFormat | null = null;
let fullFormat: Intl.DateTimeFormat | null = null;

function shortTime(iso: string, nowMs: number): string {
  const date = new Date(iso);
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    return timeFormat.format(date);
  }
  dateFormat ??= new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  return dateFormat.format(date);
}

export function CallTime({ iso, full = false }: { iso: string; full?: boolean }) {
  const now = useNow();
  // `full` (the /calls/[id] summary): complete date + time, styled by context.
  if (full) {
    fullFormat ??= new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    return (
      <time dateTime={iso} suppressHydrationWarning>
        {fullFormat.format(new Date(iso))}
      </time>
    );
  }
  return (
    <time dateTime={iso} suppressHydrationWarning className="text-muted-foreground shrink-0 text-[11px]">
      {shortTime(iso, now)}
    </time>
  );
}
