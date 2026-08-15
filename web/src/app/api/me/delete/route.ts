import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { eq } from "@/lib/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/get-session";
import { checkRateLimit } from "@/lib/rate-limit";

const CONFIRM_PASSWORD_LIMIT = { windowSeconds: 15 * 60, max: 5 }; // 5/15min/user, shared "confirm-password gate"
const DELETE_SCHEDULE_LIMIT = { windowSeconds: 24 * 60 * 60, max: 3 }; // 3/day/user
const DELETION_GRACE_DAYS = 30;

// Schedules account deletion (Docs/user/profile.md — Delete Account flow):
// password + typed-username confirmation, then a 30-day grace period. Does
// NOT call Better Auth's own /delete-user — that hard-deletes the row, which
// CLAUDE.md's "never hard-delete a user" rule forbids; this only stamps
// deletionScheduledAt. Logging back in during the window cancels it (see
// web/src/lib/get-session.ts). No session revocation here, per the doc.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  const confirmUsername = typeof body?.confirmUsername === "string" ? body.confirmUsername.trim().toLowerCase() : "";
  if (!password || !confirmUsername) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const scheduleOk = await checkRateLimit(`delete-account:${userId}`, DELETE_SCHEDULE_LIMIT.windowSeconds, DELETE_SCHEDULE_LIMIT.max);
  if (!scheduleOk) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const passwordOk = await checkRateLimit(`confirm-password:${userId}`, CONFIRM_PASSWORD_LIMIT.windowSeconds, CONFIRM_PASSWORD_LIMIT.max);
  if (!passwordOk) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  try {
    await auth.api.verifyPassword({ body: { password }, headers: await headers() });
  } catch (err) {
    if (err instanceof APIError) return NextResponse.json({ error: "Incorrect password" }, { status: 400 });
    throw err;
  }

  if (confirmUsername !== session.user.username) {
    return NextResponse.json({ error: "Username doesn't match" }, { status: 400 });
  }

  const deletionScheduledAt = new Date(Date.now() + DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000);
  await db.update(user).set({ deletionScheduledAt }).where(eq(user.id, userId));

  return NextResponse.json({ success: true, deletionScheduledAt: deletionScheduledAt.toISOString() });
}
