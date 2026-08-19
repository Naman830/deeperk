import { and, asc, desc, eq, inArray, isNull, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import {
  conversation,
  conversationMember,
  message,
  messageDeletion,
  user,
  privacySettings,
} from "../../../../db/schema";
import { avatarUrl } from "@/lib/avatar-url";
import {
  HISTORY_PAGE_SIZE,
  MEDIA_PAGE_SIZE,
  MESSAGE_SEARCH_MIN_LENGTH,
  formatMessageCursor,
} from "@/lib/validation/chat";
import { escapeLikePattern } from "@/lib/validation/search";
import { getMembership } from "./membership";
import { toChatUser } from "./conversations";
import { presenceVisible } from "@/lib/profile/privacy";
import type { ChatMember, ChatMessage, ConversationDetail } from "./types";

type MessageRow = typeof message.$inferSelect;

/**
 * Tombstones are returned, never filtered out.
 *
 * Dropping them would make `hasMore` and the page size lie, and would break the
 * cursor. The content is nulled at delete time in the database, so there is
 * nothing to hide here — a deleted message that still carried its body would be
 * a soft delete of the UI, not of the data.
 */
export function toChatMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    type: row.type,
    body: row.body,
    mediaUrl: row.mediaUrl,
    mediaMime: row.mediaMime,
    mediaSize: row.mediaSize,
    mediaName: row.mediaName,
    mediaWidth: row.mediaWidth,
    mediaHeight: row.mediaHeight,
    mediaDurationMs: row.mediaDurationMs,
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    replyToId: row.replyToId,
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
}

/**
 * "Delete for me" filter.
 *
 * NOT EXISTS rather than a leftJoin ... IS NULL: the anti-join leaves
 * idx_message_conversation_created_at serving the keyset page, and it cannot
 * multiply rows the way a join can. It also has to happen in SQL, not after the
 * fetch — every caller here reads `limit + 1` rows to decide `hasMore`, so
 * filtering in JS afterwards would make both that flag and the page size lie.
 * Same reasoning the tombstone note above already spells out.
 */
function notHiddenFor(viewerId: string) {
  return sql`not exists (
    select 1 from ${messageDeletion}
    where ${messageDeletion.messageId} = ${message.id}
      and ${messageDeletion.userId} = ${viewerId}
  )`;
}

/**
 * "Clear chat" watermark.
 *
 * Resolved by a correlated subquery rather than passed in as an option, and
 * that is the whole point: an option is something a caller can forget, and
 * forgetting this one silently un-clears a chat the user cleared. The subquery
 * is a primary-key lookup on conversation_member, so it costs essentially
 * nothing and it cannot be omitted by accident.
 *
 * COALESCE to -infinity, not to NULL: a bare `created_at > NULL` is NULL —
 * never true — so a member who has never cleared the chat would see no history
 * at all. Exactly the trap COALESCE(lastReadAt, joinedAt) already guards
 * against in the sidebar's unread count.
 */
function notClearedFor(conversationId: string, viewerId: string) {
  return sql`${message.createdAt} > coalesce((
    select ${conversationMember.clearedAt} from ${conversationMember}
    where ${conversationMember.conversationId} = ${conversationId}
      and ${conversationMember.userId} = ${viewerId}
  ), '-infinity'::timestamptz)`;
}

/** Every predicate that decides whether this viewer may see a message at all. */
function visibleTo(conversationId: string, viewerId: string) {
  return and(
    eq(message.conversationId, conversationId),
    notHiddenFor(viewerId),
    notClearedFor(conversationId, viewerId),
  );
}

export type MessagePage = {
  /** Oldest first — render order. */
  messages: ChatMessage[];
  /** Cursor for the next older page, or null when the start has been reached. */
  nextCursor: string | null;
  hasMore: boolean;
};

/**
 * Cursor-paginated history (Docs/chat/chat.md §2.5).
 *
 * The keyset is the (createdAt, id) tuple rather than createdAt alone. Ties are
 * real, not hypothetical: statements inside one db.batch() share a transaction
 * and therefore an identical now(), so a group's SYSTEM message and its first
 * real message can collide exactly. idx_message_conversation_created_at still
 * serves the leading columns.
 */
export async function listMessages(
  conversationId: string,
  // Required, deliberately not optional: an optional viewerId silently returns
  // messages the viewer has hidden the first time a caller forgets to pass it.
  viewerId: string,
  options: { before?: { createdAt: Date; id: string }; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(options.limit ?? HISTORY_PAGE_SIZE, 50);
  const { before } = options;

  const rows = await db
    .select()
    .from(message)
    .where(
      before
        ? and(
            visibleTo(conversationId, viewerId),
            sql`(${message.createdAt}, ${message.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id})`,
          )
        : visibleTo(conversationId, viewerId),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page[page.length - 1];
  return {
    messages: page.reverse().map(toChatMessage),
    nextCursor: hasMore && oldest ? formatMessageCursor(oldest.createdAt, oldest.id) : null,
    hasMore,
  };
}

/**
 * Messages strictly newer than a cursor, oldest first.
 *
 * This is the reconnect gap-filler, and chat.md doesn't specify it: Socket.IO
 * reconnection starts a brand-new session with no replay, so anything sent
 * while a client was disconnected is otherwise lost with no error at all. The
 * same call closes the SSR race, where a message landing between the server
 * component's read and the client's first connect would vanish.
 */
export async function listMessagesAfter(
  conversationId: string,
  viewerId: string,
  after: { createdAt: Date; id: string },
  limit = 100,
): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(message)
    .where(
      and(
        visibleTo(conversationId, viewerId),
        sql`(${message.createdAt}, ${message.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id})`,
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(Math.min(limit, 200));

  return rows.map(toChatMessage);
}

/**
 * The page CONTAINING a given message, plus context on both sides.
 *
 * Needed by two features that both have to jump to a message which may be
 * hundreds of rows outside the loaded window: tapping a reply's quoted snippet,
 * and opening an in-conversation search result.
 *
 * Two bounded queries around the anchor rather than one big range: the anchor
 * itself may sit anywhere, and "N older + the anchor + N newer" is the only
 * shape that gives a stable, predictable payload regardless of where it lands.
 * A single ORDER BY ... OFFSET would have to count from one end of the history.
 */
/**
 * The anchor's own (createdAt, id), looked up by id alone.
 *
 * A jump target arrives as a bare message id — from a reply's replyToId, or a
 * search result — with no timestamp, so there is nothing to build a cursor
 * from. This resolves one, gated on membership so an id from a stranger's
 * conversation simply comes back null.
 */
export async function resolveMessageAnchor(
  conversationId: string,
  messageId: string,
): Promise<{ createdAt: Date; id: string } | null> {
  const rows = await db
    .select({ id: message.id, createdAt: message.createdAt })
    .from(message)
    .where(and(eq(message.id, messageId), eq(message.conversationId, conversationId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMessagesAround(
  conversationId: string,
  viewerId: string,
  anchor: { createdAt: Date; id: string },
  context = 15,
): Promise<MessagePage> {
  const span = Math.min(context, 25);
  const anchorTuple = sql`(${anchor.createdAt.toISOString()}::timestamptz, ${anchor.id})`;

  const [olderAndAnchor, newer] = await Promise.all([
    db
      .select()
      .from(message)
      .where(and(visibleTo(conversationId, viewerId), sql`(${message.createdAt}, ${message.id}) <= ${anchorTuple}`))
      .orderBy(desc(message.createdAt), desc(message.id))
      .limit(span + 2),
    db
      .select()
      .from(message)
      .where(and(visibleTo(conversationId, viewerId), sql`(${message.createdAt}, ${message.id}) > ${anchorTuple}`))
      .orderBy(asc(message.createdAt), asc(message.id))
      .limit(span),
  ]);

  // One extra row is read on the older side purely to answer hasMore, exactly
  // as listMessages does — the cursor must not claim there is more history when
  // the anchor already sits at the very start.
  const hasMore = olderAndAnchor.length > span + 1;
  const older = (hasMore ? olderAndAnchor.slice(0, span + 1) : olderAndAnchor).reverse();
  const oldest = older[0];

  return {
    messages: [...older, ...newer].map(toChatMessage),
    nextCursor: hasMore && oldest ? formatMessageCursor(oldest.createdAt, oldest.id) : null,
    hasMore,
  };
}

/**
 * In-conversation text search (the Phase 4 half of Docs/chat/chat.md §9).
 *
 * ILIKE over one conversation's bodies, not tsvector + GIN. The documented
 * upgrade path exists but is not needed at this scale: scoped to a single
 * conversation this is a bounded scan on an index-ordered range, and a GIN
 * index would have to be maintained on every send.
 *
 * escapeLikePattern is REUSED from the people-search module rather than
 * reimplemented — it exists precisely because an unescaped `%` turns a
 * substring search into a full dump of the conversation.
 */
export async function searchMessages(
  conversationId: string,
  viewerId: string,
  query: string,
  limit = 30,
): Promise<ChatMessage[]> {
  const term = query.trim();
  if (term.length < MESSAGE_SEARCH_MIN_LENGTH) return [];
  const pattern = `%${escapeLikePattern(term)}%`;

  const rows = await db
    .select()
    .from(message)
    .where(
      and(
        visibleTo(conversationId, viewerId),
        isNull(message.deletedAt),
        eq(message.type, "TEXT"),
        sql`${message.body} ilike ${pattern}`,
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(Math.min(limit, 50));

  return rows.map(toChatMessage);
}

/**
 * Every photo, video and file in one conversation — the "Media, links & files"
 * panel.
 *
 * Cursor-paginated on the same (createdAt, id) keyset as history, so the grid
 * scrolls with exactly the mechanism the thread already uses, and tombstones
 * are excluded because a deleted message has had its mediaUrl nulled and would
 * render as a broken tile.
 */
export async function listConversationMedia(
  conversationId: string,
  viewerId: string,
  options: { before?: { createdAt: Date; id: string }; limit?: number } = {},
): Promise<{ messages: ChatMessage[]; nextCursor: string | null; hasMore: boolean }> {
  const limit = Math.min(options.limit ?? MEDIA_PAGE_SIZE, 60);
  const { before } = options;

  const rows = await db
    .select()
    .from(message)
    .where(
      and(
        visibleTo(conversationId, viewerId),
        isNull(message.deletedAt),
        inArray(message.type, ["IMAGE", "VIDEO", "FILE", "AUDIO"]),
        before
          ? sql`(${message.createdAt}, ${message.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id})`
          : sql`true`,
      ),
    )
    .orderBy(desc(message.createdAt), desc(message.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const oldest = page[page.length - 1];

  return {
    messages: page.map(toChatMessage),
    nextCursor: hasMore && oldest ? formatMessageCursor(oldest.createdAt, oldest.id) : null,
    hasMore,
  };
}

export async function getConversationDetail(
  conversationId: string,
  viewerId: string,
): Promise<ConversationDetail | null> {
  const membership = await getMembership(conversationId, viewerId);
  if (!membership) return null;

  const [head] = await db
    .select({
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      avatarPublicId: conversation.avatarPublicId,
      createdAt: conversation.createdAt,
    })
    .from(conversation)
    .where(eq(conversation.id, conversationId))
    .limit(1);
  if (!head) return null;

  const memberRows = await db
    .select({
      userId: user.id,
      username: user.username,
      displayUsername: user.displayUsername,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarPublicId: user.avatarPublicId,
      isOnline: user.isOnline,
      lastSeenAt: user.lastSeenAt,
      onlineStatus: privacySettings.onlineStatus,
      role: conversationMember.role,
      joinedAt: conversationMember.joinedAt,
      memberLastReadAt: conversationMember.lastReadAt,
      memberLastDeliveredAt: conversationMember.lastDeliveredAt,
    })
    .from(conversationMember)
    .innerJoin(user, eq(user.id, conversationMember.userId))
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(eq(conversationMember.conversationId, conversationId))
    .orderBy(asc(conversationMember.joinedAt));

  const members: ChatMember[] = memberRows.map((row) => {
    const member: ChatMember = {
      ...toChatUser(row),
      role: row.role,
      joinedAt: row.joinedAt.toISOString(),
    };
    // Read and delivery watermarks ride on the SAME privacy gate as presence,
    // and are only *added* when it allows — never sent as null. A read
    // timestamp is strictly more revealing than "online", so someone who hides
    // presence must not leak one, and the decision is made here on the server
    // rather than hidden in the UI (chat.md §2.6).
    //
    // Your own watermarks are always included: the gate protects you from other
    // people, not from yourself, and the thread needs them to place the
    // unread divider.
    if (row.userId === viewerId || presenceVisible(row.onlineStatus)) {
      member.lastReadAt = row.memberLastReadAt?.toISOString() ?? null;
      member.lastDeliveredAt = row.memberLastDeliveredAt?.toISOString() ?? null;
    }
    return member;
  });

  return {
    id: head.id,
    type: head.type,
    name: head.name,
    avatarUrl: avatarUrl(head.avatarPublicId, 96),
    createdAt: head.createdAt.toISOString(),
    role: membership.role,
    lastReadAt: membership.lastReadAt?.toISOString() ?? null,
    pinnedAt: membership.pinnedAt?.toISOString() ?? null,
    mutedUntil: membership.mutedUntil?.toISOString() ?? null,
    archivedAt: membership.archivedAt?.toISOString() ?? null,
    members,
  };
}

/**
 * What the thread page renders. Returns null for "doesn't exist" and "you're
 * not a member" alike, so both produce one identical 404 and a conversation id
 * can't be probed for existence by watching status codes.
 */
export async function getConversationThread(conversationId: string, viewerId: string) {
  const conversationDetail = await getConversationDetail(conversationId, viewerId);
  if (!conversationDetail) return null;
  const page = await listMessages(conversationId, viewerId);
  return { conversation: conversationDetail, ...page };
}
