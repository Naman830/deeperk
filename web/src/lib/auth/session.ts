import { headers } from "next/headers";
import { auth } from "./server";
import { db } from "../db";
import { eq } from "../db/drizzle-ops";
import { user } from "../../../../db/schema";

/**
 * Server-side session read for server components / route handlers.
 *
 * Also cancels a pending account deletion: Docs/user/profile.md's Delete
 * Account flow says "log in within 30 days → deletion silently cancelled".
 * A login event isn't separately tracked anywhere else in this app, so this
 * is the one choke point every authenticated request already passes through
 * — clearing it here on any authenticated access (not just the literal
 * sign-in call) is a superset of "logs in" and fails safer, not narrower.
 */
export async function getSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session?.user.deletionScheduledAt) {
    await db.update(user).set({ deletionScheduledAt: null }).where(eq(user.id, session.user.id));
    session.user.deletionScheduledAt = null;
  }
  return session;
}
