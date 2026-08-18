import { and, count, desc, eq, inArray, isNull, lt, ne, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember, message, user, privacySettings } from "../../../../db/schema";
import { avatarUrl } from "@/lib/avatar-url";
import { presenceVisible } from "@/lib/profile/privacy";
import type { ChatUser, ConversationSummary, MessageType } from "./types";

export const CONVERSATION_PAGE_SIZE = 30;

/**
 * The sidebar query (Docs/chat/chat.md §2.5, §4, §6).
 *
 * Four bounded queries, never one per conversation: the memberships, the last
 * message per conversation, all unread counts at once, and every member row.
 * The naive shape — loop the conversations and fetch each one's last message —
 * is 1 + 3N Neon round trips for a list that renders on every page load.
 */
export async function listConversations(
  userId: string,
  options: { limit?: number; before?: Date } = {},
): Promise<{ conversations: ConversationSummary[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? CONVERSATION_PAGE_SIZE, 50);

  // 1. My conversations, newest activity first.
  const rows = await db
    .select({
      id: conversation.id,
      type: conversation.type,
      name: conversation.name,
      avatarPublicId: conversation.avatarPublicId,
      updatedAt: conversation.updatedAt,
      role: conversationMember.role,
      lastReadAt: conversationMember.lastReadAt,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .where(
      options.before
        ? and(eq(conversationMember.userId, userId), lt(conversation.updatedAt, options.before))
        : eq(conversationMember.userId, userId),
    )
    .orderBy(desc(conversation.updatedAt))
    .limit(limit + 1);

  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? page[page.length - 1].updatedAt.toISOString() : null;
  if (page.length === 0) return { conversations: [], nextCursor: null };

  const ids = page.map((row) => row.id);

  const [lastMessages, unreadCounts, memberRows] = await Promise.all([
    // 2. Newest message per conversation. DISTINCT ON needs the leading ORDER
    //    BY column to match, then createdAt DESC picks the newest of each group.
    db
      .selectDistinctOn([message.conversationId], {
        conversationId: message.conversationId,
        id: message.id,
        senderId: message.senderId,
        type: message.type,
        body: message.body,
        mediaName: message.mediaName,
        createdAt: message.createdAt,
        deletedAt: message.deletedAt,
      })
      .from(message)
      .where(inArray(message.conversationId, ids))
      .orderBy(message.conversationId, desc(message.createdAt), desc(message.id)),

    // 3. Every unread count in one grouped query.
    //    COALESCE(lastReadAt, joinedAt) is load-bearing: lastReadAt is nullable
    //    with no default, so a bare `createdAt > lastReadAt` is NULL — never
    //    true — and every brand-new member's badge would read zero forever.
    //    Falling back to joinedAt also encodes the right policy: you are not
    //    unread for history from before you joined.
    db
      .select({ conversationId: message.conversationId, unread: count() })
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
          inArray(message.conversationId, ids),
          isNull(message.deletedAt),
          ne(message.senderId, userId), // your own send must not bump your own badge
          sql`${message.createdAt} > COALESCE(${conversationMember.lastReadAt}, ${conversationMember.joinedAt})`,
        ),
      )
      .groupBy(message.conversationId),

    // 4. Members — supplies the DM counterpart, the group member count, and
    //    presence. leftJoin because "no privacy_settings row" is the common case.
    db
      .select({
        conversationId: conversationMember.conversationId,
        userId: user.id,
        username: user.username,
        displayUsername: user.displayUsername,
        firstName: user.firstName,
        lastName: user.lastName,
        avatarPublicId: user.avatarPublicId,
        isOnline: user.isOnline,
        lastSeenAt: user.lastSeenAt,
        onlineStatus: privacySettings.onlineStatus,
      })
      .from(conversationMember)
      .innerJoin(user, eq(user.id, conversationMember.userId))
      .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
      .where(inArray(conversationMember.conversationId, ids)),
  ]);

  const lastByConversation = new Map(lastMessages.map((row) => [row.conversationId, row]));
  const unreadByConversation = new Map(unreadCounts.map((row) => [row.conversationId, Number(row.unread)]));

  const membersByConversation = new Map<string, typeof memberRows>();
  for (const row of memberRows) {
    const bucket = membersByConversation.get(row.conversationId);
    if (bucket) bucket.push(row);
    else membersByConversation.set(row.conversationId, [row]);
  }

  const conversations = page.map((row): ConversationSummary => {
    const members = membersByConversation.get(row.id) ?? [];
    const last = lastByConversation.get(row.id);

    const summary: ConversationSummary = {
      id: row.id,
      type: row.type,
      name: row.name,
      avatarUrl: avatarUrl(row.avatarPublicId, 96),
      updatedAt: row.updatedAt.toISOString(),
      role: row.role,
      lastReadAt: row.lastReadAt?.toISOString() ?? null,
      unreadCount: unreadByConversation.get(row.id) ?? 0,
      memberCount: members.length,
      lastMessage: last
        ? {
            id: last.id,
            senderId: last.senderId,
            type: last.type,
            preview: messagePreview(last),
            createdAt: last.createdAt.toISOString(),
            deletedAt: last.deletedAt?.toISOString() ?? null,
          }
        : null,
    };

    if (row.type === "DIRECT") {
      const other = members.find((member) => member.userId !== userId);
      if (other) summary.otherUser = toChatUser(other);
    }

    return summary;
  });

  return { conversations, nextCursor };
}

type MemberRow = {
  userId: string;
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarPublicId: string | null;
  isOnline: boolean;
  lastSeenAt: Date | null;
  onlineStatus: string | null;
};

/** Presence keys are only *added* when visible — absent means hidden, which is
 *  a different state from `isOnline: false`. Same contract as getPublicProfile. */
export function toChatUser(row: MemberRow): ChatUser {
  const chatUser: ChatUser = {
    id: row.userId,
    username: row.username,
    displayUsername: row.displayUsername,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarUrl: avatarUrl(row.avatarPublicId, 96),
  };
  if (presenceVisible(row.onlineStatus)) {
    chatUser.isOnline = row.isOnline;
    chatUser.lastSeenAt = row.lastSeenAt?.toISOString() ?? null;
  }
  return chatUser;
}

const PREVIEW_MAX = 120;

/** Derived server-side so a 4000-char body isn't shipped once per sidebar row. */
export function messagePreview(row: {
  type: MessageType;
  body: string | null;
  mediaName: string | null;
  deletedAt: Date | null;
}): string {
  if (row.deletedAt) return "This message was deleted";
  switch (row.type) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "FILE":
      return row.mediaName ?? "File";
    case "CALL":
      return "Call";
    default:
      return (row.body ?? "").slice(0, PREVIEW_MAX);
  }
}
