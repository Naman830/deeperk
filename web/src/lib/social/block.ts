import { and, eq, or, sql } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { block, user } from "../../../../db/schema";

/**
 * Is there a block in either direction between these two people?
 *
 * BOTH directions, always. A blocker who could still be messaged by the person
 * they blocked has not blocked them in any useful sense, and a one-way check is
 * the easy mistake here.
 *
 * Callers must answer a blocked request with whatever they would answer for a
 * user that does not exist. Never "you are blocked" — that turns the block into
 * a notification, which is information the blocker did not agree to share.
 */
export async function blockedBetween(a: string, b: string): Promise<boolean> {
  const rows = await db
    .select({ blockerId: block.blockerId })
    .from(block)
    .where(
      or(
        and(eq(block.blockerId, a), eq(block.blockedId, b)),
        and(eq(block.blockerId, b), eq(block.blockedId, a)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * SQL predicate form of blockedBetween, for queries that already select over
 * `user` and must simply not return blocked people (search, group-add).
 *
 * A predicate rather than a two-step "fetch then filter": both call sites are
 * LIMITed, so filtering afterwards would silently shorten the page — a search
 * for someone with three blocked users ahead of them alphabetically would
 * return seven results instead of ten.
 */
export function notBlockedWith(viewerId: string) {
  return sql`not exists (
    select 1 from ${block}
    where (${block.blockerId} = ${viewerId} and ${block.blockedId} = ${user.id})
       or (${block.blockerId} = ${user.id} and ${block.blockedId} = ${viewerId})
  )`;
}
