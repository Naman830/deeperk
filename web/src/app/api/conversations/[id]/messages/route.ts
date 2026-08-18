import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { listMessages, listMessagesAfter } from "@/lib/chat/messages";
import { parseMessageCursor, HISTORY_MAX_PAGE_SIZE } from "@/lib/validation/chat";

// Cursor-paginated history (Docs/chat/chat.md §2.5). `after` is not in the doc:
// Socket.IO reconnection starts a fresh session with no replay, so it's the
// only way a client recovers messages sent while it was disconnected.
const HISTORY_LIMIT = { windowSeconds: 60, max: 60 };

const NOT_FOUND = { error: "Conversation not found" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(`chat-history:${userId}`, HISTORY_LIMIT.windowSeconds, HISTORY_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  const searchParams = new URL(request.url).searchParams;
  const before = parseMessageCursor(searchParams.get("before"));
  const after = parseMessageCursor(searchParams.get("after"));
  // A malformed cursor is a 400. Falling back to page 1 would read to the
  // client as "here's the next page" forever and loop its infinite scroll.
  if (before === "invalid" || after === "invalid") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, HISTORY_MAX_PAGE_SIZE) : undefined;

  if (after) {
    const messages = await listMessagesAfter(id, after);
    return NextResponse.json({ messages, nextCursor: null, hasMore: false });
  }

  const page = await listMessages(id, { before: before ?? undefined, limit });
  return NextResponse.json(page);
}
