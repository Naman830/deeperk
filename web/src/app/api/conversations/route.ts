import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { listConversations } from "@/lib/chat/conversations";

// Sidebar list (Docs/chat/chat.md §2.5, §6). Server components call
// listConversations() directly instead of fetching this route — it exists for
// the client's resync-on-reconnect.
const LIST_LIMIT = { windowSeconds: 60, max: 120 }; // generous: re-fetched on every socket reconnect

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const withinLimit = await checkRateLimit(`conversation-list:${userId}`, LIST_LIMIT.windowSeconds, LIST_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const rawBefore = new URL(request.url).searchParams.get("before");
  let before: Date | undefined;
  if (rawBefore) {
    const parsed = new Date(rawBefore);
    // A bad cursor is a 400, never a silent fall back to page 1 — that reads to
    // the client as "there's more" forever and loops its infinite scroll.
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    before = parsed;
  }

  const result = await listConversations(userId, { before });
  return NextResponse.json(result);
}
