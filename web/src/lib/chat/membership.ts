import { and, eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { conversation, conversationMember } from "../../../../db/schema";
import type { ConversationType, MemberRole } from "./types";

export type Membership = {
  conversationId: string;
  type: ConversationType;
  role: MemberRole;
  lastReadAt: Date | null;
  /** Per-member conversation state. Never visible to the other members. */
  pinnedAt: Date | null;
  mutedUntil: Date | null;
  archivedAt: Date | null;
  clearedAt: Date | null;
  hiddenAt: Date | null;
};

/**
 * The authorization primitive for every chat surface (Docs/chat/chat.md §2.4).
 *
 * Returns null for "no such conversation" AND "you're not a member" — callers
 * must render one identical 404 for both, or the endpoint becomes an oracle
 * for whether a conversation id exists.
 *
 * A composite-PK lookup, so this is cheap enough to run per request rather than
 * cached. Deliberately not cached: a stale cache would let a just-removed
 * member keep posting, which is the exact thing the check exists to stop.
 */
export async function getMembership(conversationId: string, userId: string): Promise<Membership | null> {
  const rows = await db
    .select({
      conversationId: conversationMember.conversationId,
      type: conversation.type,
      role: conversationMember.role,
      lastReadAt: conversationMember.lastReadAt,
      pinnedAt: conversationMember.pinnedAt,
      mutedUntil: conversationMember.mutedUntil,
      archivedAt: conversationMember.archivedAt,
      clearedAt: conversationMember.clearedAt,
      hiddenAt: conversationMember.hiddenAt,
    })
    .from(conversationMember)
    .innerJoin(conversation, eq(conversation.id, conversationMember.conversationId))
    .where(and(eq(conversationMember.conversationId, conversationId), eq(conversationMember.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

export function canManageGroup(role: MemberRole): boolean {
  return role === "OWNER" || role === "ADMIN";
}
