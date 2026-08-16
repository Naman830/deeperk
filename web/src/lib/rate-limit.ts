import { sql } from "./db/drizzle-ops";
import { db } from "./db";
import { rateLimitHit } from "../../../db/schema";

/**
Request
  ↓
checkRateLimit(bucketKey, windowSeconds, max)
  ↓
Find bucket in DB
  ↓
Is the old window expired?
 ├─ Yes → reset count to 1
 └─ No  → increase count
  ↓
count <= max ?
 ├─ Yes → true → allow request
 └─ No  → false → reject request

 * DB-backed fixed-window limiter.
 * Uses one atomic upsert so concurrent requests cannot race.
 */

export async function checkRateLimit(
  bucketKey: string, // who/what is being limited
  windowSeconds: number, // time window
  max: number, // allowed hits
): Promise<boolean> {
  const now = new Date();
  const windowStartCutoff = new Date(now.getTime() - windowSeconds * 1000);

  const [row] = await db
    .insert(rateLimitHit)
    .values({ bucketKey, windowStart: now, count: 1 })
     .onConflictDoUpdate({
      target: rateLimitHit.bucketKey,
      set: {
        windowStart: sql`
          CASE
            WHEN ${rateLimitHit.windowStart} < ${windowStartCutoff}
            THEN ${now}
            ELSE ${rateLimitHit.windowStart}
          END
        `,
        count: sql`
          CASE
            WHEN ${rateLimitHit.windowStart} < ${windowStartCutoff}
            THEN 1
            ELSE ${rateLimitHit.count} + 1
          END
        `,
      },
    })
    .returning({ count: rateLimitHit.count });
  return row.count <= max;
}
