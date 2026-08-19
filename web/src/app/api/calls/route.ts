import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { CALL_HISTORY_MAX_PAGE_SIZE, listCallHistory, parseCallCursor } from "@/lib/call/history";

// Cursor-paginated call history for the /calls list's "Load more". Mirrors the
// messages route minus the membership gate: this feed is inherently
// viewer-scoped (listCallHistory joins the viewer's own memberships), so there
// is no conversation id to check.
const HISTORY_LIMIT = { windowSeconds: 60, max: 60 };

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const withinLimit = await checkRateLimit(`call-history:${userId}`, HISTORY_LIMIT.windowSeconds, HISTORY_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const searchParams = new URL(request.url).searchParams;
  const before = parseCallCursor(searchParams.get("before"));
  // A malformed cursor is a 400. Falling back to page 1 would read to the
  // client as "here's the next page" forever and loop its pager.
  if (before === "invalid") return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const rawLimit = Number(searchParams.get("limit"));
  const limit =
    Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, CALL_HISTORY_MAX_PAGE_SIZE) : undefined;

  return NextResponse.json(await listCallHistory(userId, { before: before ?? undefined, limit }));
}
