import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message } from "../../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { toChatMessage } from "@/lib/chat/messages";
import { notifySocket } from "@/lib/chat/notify-socket";

/**
 * Forward messages from another conversation into this one.
 *
 * REST rather than a socket event, because it is the one send that reads from a
 * conversation the socket handler has no reason to touch: it needs a membership
 * check on BOTH the source and the destination, and it cannot reuse
 * message:send's media path at all — that path is driven by a 10-minute,
 * conversation-scoped upload token, and there is no fresh upload here.
 *
 * Media is re-referenced by URL and public_id, never re-uploaded. Two rows then
 * point at one Cloudinary asset, which is why the (still unbuilt) orphan sweep
 * has to count references before destroying anything.
 *
 * NO PROVENANCE IS STORED. A `forwardedFromId` column was considered and
 * rejected: it leaks the existence of the source conversation to someone who
 * was never in it, and nothing in the UI needs it.
 */
const FORWARD_LIMIT = { windowSeconds: 60, max: 30 };
const MAX_FORWARD = 20;

const NOT_FOUND = { error: "Conversation not found" };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const { id: targetId } = await params;

  const withinLimit = await checkRateLimit(`forward:${userId}`, FORWARD_LIMIT.windowSeconds, FORWARD_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = (await request.json().catch(() => null)) as { messageIds?: unknown } | null;
  const raw = Array.isArray(body?.messageIds) ? body.messageIds : [];
  const messageIds = [...new Set(raw.filter((value): value is string => typeof value === "string"))];
  if (messageIds.length === 0 || messageIds.length > MAX_FORWARD) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Destination first — you must be a member of where it is going.
  const target = await getMembership(targetId, userId);
  if (!target) return NextResponse.json(NOT_FOUND, { status: 404 });

  // Source: every message must live in a conversation this user is ALSO in.
  // The innerJoin is the authorization, so a message id from a stranger's chat
  // simply returns no row rather than a distinguishable error.
  const sources = await db
    .select({
      id: message.id,
      type: message.type,
      body: message.body,
      mediaUrl: message.mediaUrl,
      mediaPublicId: message.mediaPublicId,
      mediaMime: message.mediaMime,
      mediaSize: message.mediaSize,
      mediaName: message.mediaName,
      mediaWidth: message.mediaWidth,
      mediaHeight: message.mediaHeight,
      createdAt: message.createdAt,
    })
    .from(message)
    .innerJoin(
      conversationMember,
      and(
        eq(conversationMember.conversationId, message.conversationId),
        eq(conversationMember.userId, userId),
      ),
    )
    .where(
      and(
        inArray(message.id, messageIds),
        isNull(message.deletedAt),
        // SYSTEM and CALL bubbles are server-authored notices about a specific
        // conversation. Forwarding one would place "Alice removed Bob" into a
        // group where neither of them is a member.
        inArray(message.type, ["TEXT", "IMAGE", "VIDEO", "FILE"]),
      ),
    )
    .orderBy(message.createdAt);

  if (sources.length === 0) return NextResponse.json({ error: "Nothing to forward" }, { status: 404 });

  const rows = sources.map((source) => ({
    id: randomUUID(),
    conversationId: targetId,
    senderId: userId,
    type: source.type,
    body: source.body,
    mediaUrl: source.mediaUrl,
    mediaPublicId: source.mediaPublicId,
    mediaMime: source.mediaMime,
    mediaSize: source.mediaSize,
    mediaName: source.mediaName,
    mediaWidth: source.mediaWidth,
    mediaHeight: source.mediaHeight,
    // No clientMsgId: these are not optimistic sends, so there is no bubble
    // waiting to be reconciled and nothing for the retry unique index to catch.
  }));

  const batched = await db.batch([
    db.insert(message).values(rows).returning(),
    // updatedAt has no $onUpdate on this table — every path that should re-sort
    // the sidebar sets it by hand, or the forward never surfaces in the list.
    db.update(conversation).set({ updatedAt: sql`now()` }).where(eq(conversation.id, targetId)),
  ]);
  // db.batch's tuple element widens to `any[] | NeonHttpQueryResult<never>`, so
  // the row shape has to be restated. It IS the returning() of the insert above.
  const inserted = batched[0] as (typeof message.$inferSelect)[];

  // One event per message, matching the shape every client already listens for.
  const saved = inserted.map(toChatMessage);
  for (const forwarded of saved) {
    await notifySocket({ kind: "message.created", conversationId: targetId, message: forwarded });
  }

  return NextResponse.json({ success: true, messages: saved });
}
