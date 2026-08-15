import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { eq } from "@/lib/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/get-session";
import { usernameSchema, toCanonicalUsername } from "@/lib/validation/signup";

const CHANGE_COOLDOWN_DAYS = 30;

// Username change (Docs/user/profile.md §4: 1 change/30 days). Uniqueness +
// shape re-validation is handled by the `username` Better Auth plugin's own
// /update-user hook (web/src/lib/auth.ts) — this route only layers the
// app-specific cooldown on top and stamps usernameChangedAt after success.
//
// KNOWN GAP: the doc also says the old handle is held/reserved for 30 days
// before release. There's no schema for that (no "reserved username" table)
// — this was a genuine new-table decision outside this pass's scope, so the
// old username becomes immediately available to anyone else the moment this
// succeeds. Flagging rather than silently building it.
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

  const rows = await db.select({ usernameChangedAt: user.usernameChangedAt }).from(user).where(eq(user.id, userId)).limit(1);
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

  await db.update(user).set({ usernameChangedAt: new Date() }).where(eq(user.id, userId));

  return NextResponse.json({ success: true, username: canonicalUsername, displayUsername });
}
