import { sql } from "./drizzle-ops";
import { db } from "./db";
import { rateLimitHit } from "../../../db/schema";

/**
 * DB-backed fixed-window rate limiter for the per-email / per-IP limits in
 * Docs/user/auth.md that Better Auth's own IP+path-keyed limiter can't
 * express (every rule here blends `email` and/or is scoped to a custom
 * route Better Auth never sees). DB-backed rather than in-memory because
 * these are security-relevant brute-force limits that must survive
 * `next dev` hot-reload and multiple server instances — an in-memory Map
 * would silently reset on either.
 *
 * Implemented as a single atomic upsert (not a separate read-then-write) so
 * concurrent requests against the same bucket can't race past each other:
 * a fresh/expired window resets the row to count 1, a live window
 * increments it, and the DB's row-level locking on the conflicting unique
 * key serializes concurrent hits to the same bucket. NOTE: Neon's
 * `neon-http` driver used by db/index.js has no transaction support at all,
 * which is exactly why this is one statement rather than a
 * read-check-then-write sequence wrapped in a transaction.
 *
 * Returns true if the call is within the limit (and the hit was recorded),
 * false if the bucket was already exhausted for the current window.
 */
export async function checkRateLimit(
  bucketKey: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowSeconds * 1000);

  const [row] = await db
    .insert(rateLimitHit)
    .values({ bucketKey, windowStart: now, count: 1 })
    .onConflictDoUpdate({
      target: rateLimitHit.bucketKey,
      set: {
        windowStart: sql`CASE WHEN ${rateLimitHit.windowStart} < ${windowStartCutoff} THEN ${now} ELSE ${rateLimitHit.windowStart} END`,
        count: sql`CASE WHEN ${rateLimitHit.windowStart} < ${windowStartCutoff} THEN 1 ELSE ${rateLimitHit.count} + 1 END`,
      },
    })
    .returning({ count: rateLimitHit.count });

  return row.count <= max;
}
