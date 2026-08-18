import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message, user, privacySettings } from "../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { discoverableFilter } from "@/lib/profile/privacy";
import { notBlockedWith } from "@/lib/social/block";
import { addMembersSchema, GROUP_MAX_MEMBERS } from "@/lib/validation/chat";
import { getMembership, canManageGroup } from "@/lib/chat/membership";
import { notifySocket } from "@/lib/chat/notify-socket";

const ADD_MEMBER_LIMIT = { windowSeconds: 60 * 60, max: 20 }; // actor-keyed, doc-silent
// Every limit in chat.md §7 is keyed on the actor, so nothing there stops one
// person being added to group after group. This one is keyed on the victim.
const ADD_TARGET_LIMIT = { windowSeconds: 24 * 60 * 60, max: 10 };

const NOT_FOUND = { error: "Conversation not found" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id } = await params;

  const withinLimit = await checkRateLimit(
    `group-members:${userId}`,
    ADD_MEMBER_LIMIT.windowSeconds,
    ADD_MEMBER_LIMIT.max,
  );
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = addMembersSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }

  const membership = await getMembership(id, userId);
  if (!membership) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (membership.type !== "GROUP") {
    return NextResponse.json({ error: "You can't add people to a direct conversation" }, { status: 400 });
  }
  // chat.md §5 lets any MEMBER add anyone; restricted to OWNER/ADMIN here on
  // the owner's instruction, which also shrinks §5's own admitted spam surface.
  if (!canManageGroup(membership.role)) {
    return NextResponse.json({ error: "Only group admins can add people" }, { status: 403 });
  }

  const [existing, candidates] = await Promise.all([
    db
      .select({ userId: conversationMember.userId })
      .from(conversationMember)
      .where(eq(conversationMember.conversationId, id)),
    // Same discoverable gate as DM creation — otherwise hiding yourself is
    // bypassed by being added to a group instead.
    db
      .select({ id: user.id })
      .from(user)
      .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
      .where(
        and(
          inArray(user.username, [...new Set(parsed.data.usernames)]),
          isNull(user.deactivatedAt),
          isNull(user.deletionScheduledAt),
          discoverableFilter(),
          // You can't be added to a group by someone you blocked, or by someone
          // who blocked you. Dropped silently along with the other rejected
          // candidates below, so this stays out of the oracle.
          notBlockedWith(userId),
        ),
      ),
  ]);

  const alreadyIn = new Set(existing.map((row) => row.userId));
  const fresh = candidates.filter((candidate) => !alreadyIn.has(candidate.id));

  // Rejected candidates are dropped silently rather than named — reporting
  // which ones failed would turn this into a discoverable-status oracle.
  const additions: string[] = [];
  for (const candidate of fresh) {
    const allowed = await checkRateLimit(
      `group-add-target:${candidate.id}`,
      ADD_TARGET_LIMIT.windowSeconds,
      ADD_TARGET_LIMIT.max,
    );
    if (allowed) additions.push(candidate.id);
  }

  if (additions.length === 0) {
    return NextResponse.json({ error: "Those people couldn't be added" }, { status: 400 });
  }
  if (alreadyIn.size + additions.length > GROUP_MAX_MEMBERS) {
    return NextResponse.json({ error: `This group is full (${GROUP_MAX_MEMBERS} members)` }, { status: 409 });
  }

  const actor = `${session.user.firstName ?? ""} ${session.user.lastName ?? ""}`.trim() || session.user.username;

  await db.batch([
    db
      .insert(conversationMember)
      .values(additions.map((memberId) => ({ conversationId: id, userId: memberId, role: "MEMBER" as const })))
      .onConflictDoNothing(),
    db.insert(message).values({
      id: randomUUID(),
      conversationId: id,
      senderId: userId,
      type: "SYSTEM",
      body: `${actor} added ${additions.length} ${additions.length === 1 ? "person" : "people"} to the group`,
    }),
    db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, id)),
  ]);

  await notifySocket({ kind: "members.added", conversationId: id, userIds: additions, by: userId });

  return NextResponse.json({ success: true, added: additions.length }, { status: 201 });
}
