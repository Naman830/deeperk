import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq, and } from "@/lib/drizzle-ops";
import { db } from "@/lib/db";
import { user, pendingContactChange } from "../../../../../../../db/schema";
import { auth } from "@/lib/auth";
import { getSession } from "@/lib/get-session";
import { checkRateLimit } from "@/lib/rate-limit";
import { otpSchema } from "@/lib/validation/signup";
import { sendEmailChangedNoticeEmail } from "@/lib/resend";

const MAX_ATTEMPTS = 3;
const EMAIL_CHANGE_VERIFY_LIMIT = { windowSeconds: 60 * 60, max: 10 }; // 10/hour/user

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

// Step 2 of email change: verify the OTP sent to the new address, then apply
// the change and revoke every other session (Docs/user/profile.md §5).
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const verifyOk = await checkRateLimit(`email-change-verify:${userId}`, EMAIL_CHANGE_VERIFY_LIMIT.windowSeconds, EMAIL_CHANGE_VERIFY_LIMIT.max);
  if (!verifyOk) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const otpParsed = otpSchema.safeParse(body?.otp);
  if (!otpParsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const otp = otpParsed.data;

  const whereClause = and(eq(pendingContactChange.userId, userId), eq(pendingContactChange.type, "EMAIL"));
  const rows = await db.select().from(pendingContactChange).where(whereClause).limit(1);
  const row = rows[0];

  if (!row || row.expiresAt < new Date()) {
    if (row) await db.delete(pendingContactChange).where(whereClause);
    return NextResponse.json({ error: "Code expired. Please start over." }, { status: 400 });
  }

  if (hashOtp(otp) !== row.otpHash) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.delete(pendingContactChange).where(whereClause);
      return NextResponse.json({ error: "Too many incorrect attempts. Please start over." }, { status: 400 });
    }
    await db.update(pendingContactChange).set({ attempts }).where(whereClause);
    return NextResponse.json({ error: "Incorrect code.", attemptsRemaining: MAX_ATTEMPTS - attempts }, { status: 400 });
  }

  const oldEmail = session.user.email;
  const newEmail = row.newValue;

  await db.delete(pendingContactChange).where(whereClause);
  await db.update(user).set({ email: newEmail, emailVerified: true, updatedAt: new Date() }).where(eq(user.id, userId));

  // Keep the current session, kill every other one (Docs/user/profile.md §5).
  await auth.api.revokeOtherSessions({ headers: await headers() });

  // Best-effort — a failed notice email shouldn't undo an otherwise-successful change.
  await sendEmailChangedNoticeEmail(oldEmail, newEmail).catch(() => {});

  return NextResponse.json({ success: true, email: newEmail });
}
