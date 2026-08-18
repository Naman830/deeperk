import { NextResponse } from "next/server";
import { and, eq, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversationMember } from "../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { notifySocket } from "@/lib/chat/notify-socket";

const NOT_FOUND = { error: "Conversation not found" };

/**
 * Mark read (Docs/chat/chat.md §2.5).
 *
 * Deliberately **not** rate limited — §7 says so explicitly. The abuse control
 * is the shape of the write instead: GREATEST makes it monotonic, so repeating
 * it is genuinely idempotent and concurrent writes can't move the watermark
 * backwards.
 *
 * SQL now(), not the app clock: this column is compared against
 * message.createdAt, which is stamped by the database — and the socket server
 * writes the same column from a different process. Mixing clocks would leave
 * the last few seconds of messages permanently unread. (CLAUDE.md's app-clock
 * rule is about deadlines, which this isn't.)
 *
 * The WHERE clause *is* the authorization: zero rows updated means not a
 * member, so no separate membership query is needed.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;

  const updated = await db
    .update(conversationMember)
    .set({ lastReadAt: sql`GREATEST(COALESCE(${conversationMember.lastReadAt}, 'epoch'::timestamptz), now())` })
    .where(and(eq(conversationMember.conversationId, id), eq(conversationMember.userId, session.user.id)))
    .returning({ lastReadAt: conversationMember.lastReadAt });

  if (updated.length === 0) return NextResponse.json(NOT_FOUND, { status: 404 });

  const lastReadAt = updated[0].lastReadAt?.toISOString() ?? null;
  // Same cross-tab read-sync the socket path emits; without it a read through
  // this route leaves the other tabs' unread badges stale.
  await notifySocket({ kind: "conversation.read", conversationId: id, userId: session.user.id, lastReadAt });

  return NextResponse.json({ success: true, lastReadAt });
}
