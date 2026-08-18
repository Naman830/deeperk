import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message, user, privacySettings } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { discoverableFilter } from "@/lib/profile/privacy";
import { createGroupSchema, GROUP_MAX_MEMBERS } from "@/lib/validation/chat";
import { notifySocket } from "@/lib/chat/notify-socket";

// Create a group (Docs/chat/chat.md §2.3).
const GROUP_CREATE_LIMIT = { windowSeconds: 24 * 60 * 60, max: 5 }; // 5/day/user (chat.md §7)

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const parsed = createGroupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { name } = parsed.data;
  const requested = [...new Set(parsed.data.memberUsernames)].filter(
    (candidate) => candidate !== session.user.username?.toLowerCase(),
  );
  if (requested.length === 0) {
    return NextResponse.json({ error: "Add at least one other person" }, { status: 400 });
  }

  const withinLimit = await checkRateLimit(
    `group-create:${userId}`,
    GROUP_CREATE_LIMIT.windowSeconds,
    GROUP_CREATE_LIMIT.max,
  );
  if (!withinLimit) {
    return NextResponse.json({ error: "You've created too many groups today. Try again tomorrow." }, { status: 429 });
  }

  // The discoverable gate applies here too, which chat.md §5 does not ask for.
  // Without it the gate is bypassed in one step: make a two-person "group" with
  // someone who has hidden themselves and message them there.
  const members = await db
    .select({ id: user.id })
    .from(user)
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(
      and(
        inArray(user.username, requested),
        isNull(user.deactivatedAt),
        isNull(user.deletionScheduledAt),
        discoverableFilter(),
      ),
    );

  // Anyone filtered out is dropped silently rather than named — saying which
  // ones were rejected would turn this into a discoverable-status oracle.
  if (members.length === 0) {
    return NextResponse.json({ error: "Those people couldn't be added" }, { status: 400 });
  }
  if (members.length + 1 > GROUP_MAX_MEMBERS) {
    return NextResponse.json({ error: `A group can have up to ${GROUP_MAX_MEMBERS} members` }, { status: 400 });
  }

  // Ids generated here so nothing in the batch depends on another statement's
  // output — which is exactly what lets this be atomic on neon-http. A partial
  // failure would otherwise leave a group with no members and no OWNER:
  // invisible to everyone and unrecoverable.
  const conversationId = randomUUID();
  const creatorName = `${session.user.firstName ?? ""} ${session.user.lastName ?? ""}`.trim() || session.user.username;

  await db.batch([
    db.insert(conversation).values({ id: conversationId, type: "GROUP", name, createdById: userId }),
    db.insert(conversationMember).values([
      { conversationId, userId, role: "OWNER" },
      ...members.map((member) => ({ conversationId, userId: member.id, role: "MEMBER" as const })),
    ]),
    db.insert(message).values({
      id: randomUUID(),
      conversationId,
      senderId: userId,
      type: "SYSTEM",
      body: `${creatorName} created the group`,
    }),
  ]);

  await notifySocket({
    kind: "conversation.created",
    conversationId,
    userIds: [userId, ...members.map((member) => member.id)],
  });

  return NextResponse.json({ conversationId }, { status: 201 });
}
