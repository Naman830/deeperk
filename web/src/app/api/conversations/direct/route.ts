import { NextResponse } from "next/server";
import { and, eq, isNull } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, user, privacySettings } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { blockedBetween } from "@/lib/social/block";
import { checkRateLimit } from "@/lib/rate-limit";
import { startDirectSchema } from "@/lib/validation/chat";
import { directKey } from "@/lib/chat/direct-key";
import { notifySocket } from "@/lib/chat/notify-socket";

// Open-or-create a DM (Docs/chat/chat.md §2.2). Takes a username, not a userId
// as §2.2 says: no user id is exposed to the browser anywhere in this app, and
// the server has to look the user up for the discoverable gate regardless.
const DM_START_LIMIT = { windowSeconds: 60 * 60, max: 20 }; // 20/hour/user (chat.md §7)

// One answer for "no such user", "hidden from you", and "deactivated" — the
// same non-committal failure search already gives (chat.md §8).
const NOT_FOUND = { error: "User not found" };

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const parsed = startDirectSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { username } = parsed.data;

  if (session.user.username?.toLowerCase() === username) {
    return NextResponse.json({ error: "You can't message yourself" }, { status: 400 });
  }

  // Resolved WITHOUT the discoverable gate, because the gate applies to
  // *starting* a conversation, not reopening one that already exists. It costs
  // no extra disclosure: /api/users/[username] already confirms existence.
  const [target] = await db
    .select({
      id: user.id,
      discoverable: privacySettings.discoverable,
    })
    .from(user)
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(and(eq(user.username, username), isNull(user.deactivatedAt), isNull(user.deletionScheduledAt)))
    .limit(1);

  if (!target) return NextResponse.json(NOT_FOUND, { status: 404 });
  if (target.id === userId) return NextResponse.json({ error: "You can't message yourself" }, { status: 400 });

  // Block gate, in BOTH directions, and before the existing-conversation lookup
  // rather than after it — otherwise blocking someone you already had a DM with
  // would still hand you a working conversation id.
  //
  // Answers the same NOT_FOUND as an unknown handle. Saying "you are blocked"
  // would turn the block into a notification, which is information the blocker
  // never agreed to share.
  if (await blockedBetween(userId, target.id)) return NextResponse.json(NOT_FOUND, { status: 404 });

  const key = directKey(userId, target.id);

  // Fast path first, ahead of the rate limit. §7's 20/hour is a spam-conversation
  // guard; charging it for reopening an existing DM would break ordinary use
  // after twenty clicks. Only creation is the spam surface. The leftJoin checks
  // the caller's own member row: a previous create that crashed between the
  // conversation insert and the member insert would otherwise return an id that
  // 404s forever, since this early return skips the member insert below.
  const [existing] = await db
    .select({ id: conversation.id, memberId: conversationMember.userId })
    .from(conversation)
    .leftJoin(
      conversationMember,
      and(eq(conversationMember.conversationId, conversation.id), eq(conversationMember.userId, userId)),
    )
    .where(eq(conversation.directKey, key))
    .limit(1);
  if (existing) {
    if (!existing.memberId) await ensureMembers(existing.id, userId, target.id);
    return NextResponse.json({ conversationId: existing.id, created: false });
  }

  const withinLimit = await checkRateLimit(`dm-start:${userId}`, DM_START_LIMIT.windowSeconds, DM_START_LIMIT.max);
  if (!withinLimit) {
    return NextResponse.json({ error: "You're starting too many conversations. Try again later." }, { status: 429 });
  }

  // The gate applies only to a brand-new conversation.
  if ((target.discoverable ?? "EVERYONE") !== "EVERYONE") {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  // DoNothing, not DoUpdate: two simultaneous "Message" clicks both reach here,
  // and the unique index on direct_key turns the loser into a no-op. Returning
  // no row on conflict is the point — an upsert would report created: true to
  // both clicks, and the loser's 201 + notify would double the winner's.
  const [row] = await db
    .insert(conversation)
    .values({ type: "DIRECT", directKey: key, createdById: userId })
    .onConflictDoNothing({ target: conversation.directKey })
    .returning({ id: conversation.id });

  if (!row) {
    // Lost the race: the winner's row exists now. The member insert runs here
    // too in case the winner dies before its own — it's idempotent either way.
    const [winner] = await db
      .select({ id: conversation.id })
      .from(conversation)
      .where(eq(conversation.directKey, key))
      .limit(1);
    if (!winner) return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
    await ensureMembers(winner.id, userId, target.id);
    return NextResponse.json({ conversationId: winner.id, created: false });
  }

  // Cannot be batched with the insert above — it needs that statement's
  // returned id, and neon-http batches are non-interactive. Conversation first
  // is the safe order: losing the member rows leaves a conversation that
  // appears in nobody's sidebar (the sidebar is driven by conversation_member),
  // and the fast path above heals exactly that on the next click. The reverse
  // order is impossible anyway (FK).
  await ensureMembers(row.id, userId, target.id);

  await notifySocket({ kind: "conversation.created", conversationId: row.id, userIds: [userId, target.id] });

  return NextResponse.json({ conversationId: row.id, created: true }, { status: 201 });
}

async function ensureMembers(conversationId: string, userId: string, targetId: string): Promise<void> {
  await db
    .insert(conversationMember)
    .values([
      // Both MEMBER: nobody "administers" a DM.
      { conversationId, userId, role: "MEMBER" },
      { conversationId, userId: targetId, role: "MEMBER" },
    ])
    .onConflictDoNothing();
}
