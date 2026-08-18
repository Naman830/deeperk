import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { listMessages, listMessagesAfter, listMessagesAround, resolveMessageAnchor } from "@/lib/chat/messages";
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
  // `around` is the anchor form: the page CONTAINING a message plus context on
  // both sides. Two features need it — tapping a reply's quoted snippet, and
  // opening an in-conversation search result — and both can target a message
  // hundreds of rows outside the loaded window.
  const around = parseMessageCursor(searchParams.get("around"));
  // A malformed cursor is a 400. Falling back to page 1 would read to the
  // client as "here's the next page" forever and loop its infinite scroll.
  if (before === "invalid" || after === "invalid" || around === "invalid") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isSafeInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, HISTORY_MAX_PAGE_SIZE) : undefined;

  if (after) {
    const messages = await listMessagesAfter(id, userId, after);
    return NextResponse.json({ messages, nextCursor: null, hasMore: false });
  }

  if (around) {
    return NextResponse.json(await listMessagesAround(id, userId, around));
  }

  // `aroundId` is the same anchor form addressed by message id alone, which is
  // all a jump target ever has: a reply carries replyToId, a search result
  // carries an id, and neither knows the timestamp a cursor would need.
  const aroundId = searchParams.get("aroundId");
  if (aroundId) {
    const anchor = await resolveMessageAnchor(id, aroundId);
    // The same 404 as an unknown conversation — membership was already proven
    // above, so this only fires for an id that isn't in THIS conversation, and
    // it must not confirm that the id exists somewhere else.
    if (!anchor) return NextResponse.json({ error: "Message not found" }, { status: 404 });
    return NextResponse.json(await listMessagesAround(id, userId, anchor));
  }

  const page = await listMessages(id, userId, { before: before ?? undefined, limit });
  return NextResponse.json(page);
}
