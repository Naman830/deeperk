import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { listConversationMedia } from "@/lib/chat/messages";
import { parseMessageCursor } from "@/lib/validation/chat";

// Every photo, video and file in one conversation — the "Media, links & files"
// panel. Same keyset cursor as history, so the grid paginates with the exact
// mechanism the thread already uses.
const MEDIA_LIMIT = { windowSeconds: 60, max: 60 };

const NOT_FOUND = { error: "Conversation not found" };

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(`chat-media-list:${userId}`, MEDIA_LIMIT.windowSeconds, MEDIA_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  const before = parseMessageCursor(new URL(request.url).searchParams.get("before"));
  // A malformed cursor is a 400, never a silent fall back to page 1 — that
  // reads to the client as "here's more" forever and loops the infinite scroll.
  if (before === "invalid") return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  return NextResponse.json(await listConversationMedia(id, userId, { before: before ?? undefined }));
}
