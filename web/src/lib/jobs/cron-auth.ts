import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret gate for the /api/cron/* routes. Vercel Cron sends
 * `Authorization: Bearer <CRON_SECRET>`, but the URLs are public internet like
 * any other route, so this header is the whole auth model. Fails closed when
 * the env var is unset — same posture and same length-guarded timingSafeEqual
 * comparison as server/src/routes/internal.js's internal-secret check.
 */
export function isCronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
