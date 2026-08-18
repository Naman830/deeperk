import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { searchMessages } from "@/lib/chat/messages";
import { MESSAGE_SEARCH_MIN_LENGTH } from "@/lib/validation/chat";

// In-conversation message search. Scoped to one conversation by construction —
// searchMessages takes the id as its first argument, so there is no query shape
// that can reach another conversation's rows.
const SEARCH_LIMIT = { windowSeconds: 60, max: 60 };

const NOT_FOUND = { error: "Conversation not found" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(`chat-search:${userId}`, SEARCH_LIMIT.windowSeconds, SEARCH_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  const query = new URL(request.url).searchParams.get("q") ?? "";
  // Below the minimum this is "nothing to search", not a bad request — the same
  // posture people-search already takes, and the client never sends one anyway.
  if (query.trim().length < MESSAGE_SEARCH_MIN_LENGTH) return NextResponse.json({ messages: [] });

  return NextResponse.json({ messages: await searchMessages(id, userId, query) });
}
