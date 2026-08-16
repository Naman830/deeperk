import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { auth } from "@/lib/auth/server";
import { getSession } from "@/lib/auth/session";
import { usernameSchema, toCanonicalUsername } from "@/lib/validation/signup";
import { holdUsername } from "@/lib/auth/username-reservation";

const CHANGE_COOLDOWN_DAYS = 30;

// Username change (Docs/user/profile.md §4: 1 change/30 days). Uniqueness +
// shape re-validation is handled by the `username` Better Auth plugin's own
// /update-user hook (web/src/lib/auth/server.ts) — this route only layers the
// app-specific cooldown on top and stamps usernameChangedAt after success.
//
// The doc's other half — the old handle is held 30 days before release — is
// enforced by web/src/lib/auth/username-reservation.ts, written here on success and
// read by the hold check in web/src/lib/auth/server.ts's before-hook.
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const parsed = usernameSchema.safeParse(body?.username);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid username" }, { status: 400 });
  }
  const displayUsername = parsed.data;
  const canonicalUsername = toCanonicalUsername(displayUsername);

  // Grab the current handle in the same round trip — after updateUser it's gone.
  const rows = await db
    .select({ username: user.username, usernameChangedAt: user.usernameChangedAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const previousUsername = rows[0]?.username;
  const usernameChangedAt = rows[0]?.usernameChangedAt;
  if (usernameChangedAt) {
    const nextAllowed = new Date(usernameChangedAt.getTime() + CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
    if (nextAllowed > new Date()) {
      return NextResponse.json({ error: "You can only change your username once every 30 days", nextAllowedAt: nextAllowed.toISOString() }, { status: 429 });
    }
  }

  try {
    await auth.api.updateUser({
      body: { username: canonicalUsername, displayUsername },
      headers: await headers(),
    });
  } catch (err) {
    if (err instanceof APIError) {
      return NextResponse.json({ error: err.body?.message ?? "Could not update username" }, { status: err.statusCode ?? 400 });
    }
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }

  // One timestamp for both writes, so the hold expires at the exact instant the
  // owner's own cooldown does — never a millisecond later, which would lock them
  // out of reclaiming their old handle.
  const changedAt = new Date();

  // Stamp the cooldown BEFORE writing the hold, and don't "tidy" this order:
  // there are no transactions on neon-http, so one of the two can be lost.
  // Losing the hold just releases a handle early (today's behavior). Losing the
  // cooldown would let someone rename repeatedly, parking a handle each time.
  await db.update(user).set({ usernameChangedAt: changedAt }).where(eq(user.id, userId));

  if (previousUsername && previousUsername !== canonicalUsername) {
    await holdUsername(previousUsername, userId, changedAt);
  }

  return NextResponse.json({ success: true, username: canonicalUsername, displayUsername });
}
