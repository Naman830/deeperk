import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, asc, eq, ne, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message } from "../../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { updateMemberRoleSchema } from "@/lib/validation/chat";
import { getMembership, canManageGroup } from "@/lib/chat/membership";
import { notifySocket } from "@/lib/chat/notify-socket";

const MEMBER_LIMIT = { windowSeconds: 60 * 60, max: 20 };
const NOT_FOUND = { error: "Conversation not found" };

/** Change a member's role. OWNER only — an ADMIN who could promote admins can
 *  promote itself out of every restriction, which is not a role boundary. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const actorId = session.user.id;

  const { id, userId: rawTarget } = await params;
  const targetId = rawTarget === "me" ? actorId : rawTarget;

  const withinLimit = await checkRateLimit(`group-members:${actorId}`, MEMBER_LIMIT.windowSeconds, MEMBER_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = updateMemberRoleSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const membership = await getMembership(id, actorId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (membership.type !== "GROUP") {
    return NextResponse.json({ error: "Direct conversations have no roles" }, { status: 400 });
  }
  if (membership.role !== "OWNER") {
    return NextResponse.json({ error: "Only the group owner can change roles" }, { status: 403 });
  }
  if (targetId === actorId) {
    return NextResponse.json({ error: "You can't change your own role" }, { status: 400 });
  }

  const updated = await db
    .update(conversationMember)
    .set({ role: parsed.data.role })
    // ne(role, "OWNER") so this can never demote a co-owner sideways.
    .where(
      and(
        eq(conversationMember.conversationId, id),
        eq(conversationMember.userId, targetId),
        ne(conversationMember.role, "OWNER"),
      ),
    )
    .returning({ userId: conversationMember.userId });

  if (updated.length === 0) return NextResponse.json({ error: "That person isn't in this group" }, { status: 404 });

  // conversation.updated, not members.added: the target is already in the room,
  // and members.added would re-toast "you were added" at them.
  await notifySocket({ kind: "conversation.updated", conversationId: id });
  return NextResponse.json({ success: true, role: parsed.data.role });
}

/** Remove someone, or leave (`userId` = your own id, or the literal "me"). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; userId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const actorId = session.user.id;

  const { id, userId: rawTarget } = await params;
  const targetId = rawTarget === "me" ? actorId : rawTarget;
  const isSelf = targetId === actorId;

  const withinLimit = await checkRateLimit(`group-members:${actorId}`, MEMBER_LIMIT.windowSeconds, MEMBER_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const membership = await getMembership(id, actorId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });

  // Leaving a DM would strand a one-member row whose direct_key permanently
  // blocks ever recreating that conversation. chat.md doesn't consider it.
  if (membership.type !== "GROUP") {
    return NextResponse.json({ error: "You can't leave a direct conversation" }, { status: 400 });
  }

  const [targetRow] = await db
    .select({ role: conversationMember.role })
    .from(conversationMember)
    .where(and(eq(conversationMember.conversationId, id), eq(conversationMember.userId, targetId)))
    .limit(1);
  if (!targetRow) return NextResponse.json({ error: "That person isn't in this group" }, { status: 404 });

  if (!isSelf) {
    if (!canManageGroup(membership.role)) {
      return NextResponse.json({ error: "Only group admins can remove people" }, { status: 403 });
    }
    // An ADMIN may remove MEMBERs only; otherwise admins can depose each other
    // and the owner, which makes the role hierarchy decorative.
    if (membership.role === "ADMIN" && targetRow.role !== "MEMBER") {
      return NextResponse.json({ error: "Only the group owner can remove an admin" }, { status: 403 });
    }
  }

  // A sole OWNER leaving is undefined in chat.md, and doing nothing reaches an
  // unrecoverable no-owner group. Longest-tenured ADMIN first, then MEMBER.
  let heirId: string | null = null;
  if (targetRow.role === "OWNER") {
    const heirs = await db
      .select({ userId: conversationMember.userId, role: conversationMember.role })
      .from(conversationMember)
      .where(and(eq(conversationMember.conversationId, id), ne(conversationMember.userId, targetId)))
      .orderBy(asc(conversationMember.joinedAt));
    heirId = heirs.find((row) => row.role === "ADMIN")?.userId ?? heirs[0]?.userId ?? null;
  }

  const actor = `${session.user.firstName ?? ""} ${session.user.lastName ?? ""}`.trim() || session.user.username;
  const removal = db
    .delete(conversationMember)
    .where(and(eq(conversationMember.conversationId, id), eq(conversationMember.userId, targetId)));
  const systemMessage = db.insert(message).values({
    id: randomUUID(),
    conversationId: id,
    senderId: actorId,
    type: "SYSTEM",
    body: isSelf ? `${actor} left the group` : `${actor} removed someone from the group`,
  });
  const bump = db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, id));

  if (heirId) {
    await db.batch([
      removal,
      // Idempotent: two owners leaving at once can't produce a conflict here.
      db
        .update(conversationMember)
        .set({ role: "OWNER" })
        .where(
          and(
            eq(conversationMember.conversationId, id),
            eq(conversationMember.userId, heirId),
            ne(conversationMember.role, "OWNER"),
          ),
        ),
      systemMessage,
      bump,
    ]);
  } else {
    await db.batch([removal, systemMessage, bump]);
  }

  await notifySocket({ kind: "members.removed", conversationId: id, userIds: [targetId], by: actorId });

  return NextResponse.json({ success: true });
}
