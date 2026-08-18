import { NextResponse } from "next/server";
import { and, eq, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversationMember } from "../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { conversationStateSchema } from "@/lib/validation/chat";
import { getMembership } from "@/lib/chat/membership";
import { notifySocket } from "@/lib/chat/notify-socket";

/**
 * Pin / mute / archive — one member's own view of a conversation.
 *
 * A separate route from PATCH /api/conversations/[id] rather than more fields
 * on it, because the two differ in who they affect and who may call them:
 * renaming a group is an admin action that changes the conversation for
 * everybody, while these three change nothing anyone else can observe and are
 * available to every member including in a DM.
 */
const STATE_LIMIT = { windowSeconds: 60 * 60, max: 120 };

const NOT_FOUND = { error: "Conversation not found" };

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(`conversation-state:${userId}`, STATE_LIMIT.windowSeconds, STATE_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = conversationStateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  const { pinned, archived, muteMinutes } = parsed.data;
  const patch: Record<string, unknown> = {};
  // now() from SQL, not the app clock: every other timestamp on this row is
  // database-stamped, and mixing the two makes "muted until" drift by whatever
  // the process-vs-Neon skew happens to be.
  if (pinned !== undefined) patch.pinnedAt = pinned ? sql`now()` : null;
  if (archived !== undefined) patch.archivedAt = archived ? sql`now()` : null;
  if (muteMinutes !== undefined) {
    patch.mutedUntil = muteMinutes === null ? null : sql`now() + make_interval(mins => ${muteMinutes})`;
  }

  const updated = await db
    .update(conversationMember)
    .set(patch)
    .where(and(eq(conversationMember.conversationId, id), eq(conversationMember.userId, userId)))
    .returning({
      pinnedAt: conversationMember.pinnedAt,
      mutedUntil: conversationMember.mutedUntil,
      archivedAt: conversationMember.archivedAt,
    });

  if (updated.length === 0) return NextResponse.json(NOT_FOUND, { status: 404 });

  // The acting tab already knows; this is for the user's OTHER tabs.
  await notifySocket({ kind: "conversation.self-changed", conversationId: id, userId });

  return NextResponse.json({
    success: true,
    pinnedAt: updated[0].pinnedAt?.toISOString() ?? null,
    mutedUntil: updated[0].mutedUntil?.toISOString() ?? null,
    archivedAt: updated[0].archivedAt?.toISOString() ?? null,
  });
}
