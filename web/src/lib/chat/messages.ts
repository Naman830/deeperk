import { and, asc, desc, eq, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message, user, privacySettings } from "../../../../db/schema";
import { avatarUrl } from "@/lib/avatar-url";
import { HISTORY_PAGE_SIZE, formatMessageCursor } from "@/lib/validation/chat";
import { getMembership } from "./membership";
import { toChatUser } from "./conversations";
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
    callId: row.callId,
    clientMsgId: row.clientMsgId,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt?.toISOString() ?? null,
  };
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
            eq(message.conversationId, conversationId),
            sql`(${message.createdAt}, ${message.id}) < (${before.createdAt.toISOString()}::timestamptz, ${before.id})`,
          )
        : eq(message.conversationId, conversationId),
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
  after: { createdAt: Date; id: string },
  limit = 100,
): Promise<ChatMessage[]> {
  const rows = await db
    .select()
    .from(message)
    .where(
      and(
        eq(message.conversationId, conversationId),
        sql`(${message.createdAt}, ${message.id}) > (${after.createdAt.toISOString()}::timestamptz, ${after.id})`,
      ),
    )
    .orderBy(asc(message.createdAt), asc(message.id))
    .limit(Math.min(limit, 200));

  return rows.map(toChatMessage);
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
    })
    .from(conversationMember)
    .innerJoin(user, eq(user.id, conversationMember.userId))
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(eq(conversationMember.conversationId, conversationId))
    .orderBy(asc(conversationMember.joinedAt));

  const members: ChatMember[] = memberRows.map((row) => ({
    ...toChatUser(row),
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
  }));

  return {
    id: head.id,
    type: head.type,
    name: head.name,
    avatarUrl: avatarUrl(head.avatarPublicId, 96),
    createdAt: head.createdAt.toISOString(),
    role: membership.role,
    lastReadAt: membership.lastReadAt?.toISOString() ?? null,
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
  const page = await listMessages(conversationId);
  return { conversation: conversationDetail, ...page };
}
