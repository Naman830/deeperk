import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { renameGroupSchema, clearConversationSchema } from "@/lib/validation/chat";
import { getMembership, canManageGroup } from "@/lib/chat/membership";
import { getConversationDetail } from "@/lib/chat/messages";
import { notifySocket } from "@/lib/chat/notify-socket";

const GROUP_UPDATE_LIMIT = { windowSeconds: 60 * 60, max: 30 }; // doc-silent; house-generous

// "Doesn't exist" and "you're not a member" answer identically, or the route
// becomes an oracle for whether a conversation id is real (chat.md §2.4).
const NOT_FOUND = { error: "Conversation not found" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { id } = await params;
  const detail = await getConversationDetail(id, session.user.id);
  if (!detail) return NextResponse.json(NOT_FOUND, { status: 404 });

  return NextResponse.json(detail);
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(
    `group-update:${userId}`,
    GROUP_UPDATE_LIMIT.windowSeconds,
    GROUP_UPDATE_LIMIT.max,
  );
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = renameGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (membership.type !== "GROUP") {
    return NextResponse.json({ error: "Direct conversations can't be renamed" }, { status: 400 });
  }
  // 403 is safe here where 404 was required above: membership is already
  // proven, so the role answer discloses nothing new.
  if (!canManageGroup(membership.role)) {
    return NextResponse.json({ error: "Only group admins can do that" }, { status: 403 });
  }

  const actor = `${session.user.firstName ?? ""} ${session.user.lastName ?? ""}`.trim() || session.user.username;

  await db.batch([
    // updatedAt has no $onUpdate on this table — every path that should re-sort
    // the sidebar sets it by hand, or the change never surfaces in the list.
    db
      .update(conversation)
      .set({ name: parsed.data.name, updatedAt: sql`now()` })
      .where(eq(conversation.id, id)),
    db.insert(message).values({
      id: randomUUID(),
      conversationId: id,
      senderId: userId,
      type: "SYSTEM",
      body: `${actor} renamed the group to "${parsed.data.name}"`,
    }),
  ]);

  await notifySocket({ kind: "conversation.updated", conversationId: id, name: parsed.data.name });

  return NextResponse.json({ success: true, name: parsed.data.name });
}


/**
 * "Clear chat" and "Delete chat" — both PER-USER, never global.
 *
 * Neither WhatsApp, Instagram nor Telegram delete a DM for both sides, and this
 * repo's "never hard-delete history" posture points the same way. Nothing is
 * removed from the message table at all: `clear` stamps a watermark that the
 * history and sidebar queries filter against, `delete` stamps that plus a
 * second one that drops the row from your sidebar.
 *
 * A watermark rather than bulk message_deletion inserts, because clearing a
 * 10 000-message chat would otherwise be 10 000 rows on a driver with no
 * transactions — and a partial failure would leave it half-cleared with no way
 * to detect or resume. One timestamp is atomic and instant.
 *
 * "Delete" deliberately does NOT leave a group. Leaving is a separate, explicit
 * action that already exists in the group settings dialog, and silently
 * ejecting someone from a group because they tidied their chat list is not
 * recoverable — whereas a hidden group simply reappears when someone posts.
 * Telegram draws the same line.
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(
    `conversation-clear:${userId}`,
    GROUP_UPDATE_LIMIT.windowSeconds,
    GROUP_UPDATE_LIMIT.max,
  );
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = clearConversationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  // Both stamps come from ONE now(), not two: with `delete`, a clear watermark
  // even microseconds behind the hide would leave a sliver of history visible
  // the instant the chat reappeared.
  const now = sql`now()`;
  const updated = await db
    .update(conversationMember)
    .set(
      parsed.data.mode === "delete"
        ? { clearedAt: now, hiddenAt: now }
        : // A clear must also lift any previous hide, or clearing a chat you had
          // already deleted would leave it invisible with nothing to explain why.
          { clearedAt: now, hiddenAt: null },
    )
    .where(and(eq(conversationMember.conversationId, id), eq(conversationMember.userId, userId)))
    .returning({ clearedAt: conversationMember.clearedAt });

  if (updated.length === 0) return NextResponse.json(NOT_FOUND, { status: 404 });

  await notifySocket({ kind: "conversation.self-changed", conversationId: id, userId });

  return NextResponse.json({ success: true, mode: parsed.data.mode });
}
