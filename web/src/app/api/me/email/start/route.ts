import { randomInt, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { APIError } from "better-auth/api";
import { eq, and } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user, pendingContactChange } from "../../../../../../../db/schema";
import { auth } from "@/lib/auth/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { emailSchema } from "@/lib/validation/signup";
import { sendEmailChangeOtpEmail } from "@/lib/integrations/resend";
import { logServerError } from "@/lib/log";

const OTP_TTL_SECONDS = 5 * 60;
const CONFIRM_PASSWORD_LIMIT = { windowSeconds: 15 * 60, max: 5 }; // 5/15min/user, shared "confirm-password gate"
const EMAIL_CHANGE_START_LIMIT = { windowSeconds: 60 * 60, max: 3 }; // 3/hour/user

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

// Step 1 of email change (Docs/user/profile.md — Email change flow): confirm
// password, then send an OTP to the NEW address. Mirrors the signup OTP
// pattern (pending_registration → pending_contact_change is its profile-side
// twin), and the "inline password field" step-up decision from the Profile
// API plan — no separate confirm-password token endpoint.
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  const emailParsed = emailSchema.safeParse(body?.newEmail);
  if (!password || !emailParsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const newEmail = emailParsed.data;
  if (newEmail === session.user.email) {
    return NextResponse.json({ error: "That's already your email address" }, { status: 400 });
  }

  const passwordOk = await checkRateLimit(`confirm-password:${userId}`, CONFIRM_PASSWORD_LIMIT.windowSeconds, CONFIRM_PASSWORD_LIMIT.max);
  if (!passwordOk) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  try {
    await auth.api.verifyPassword({ body: { password }, headers: await headers() });
  } catch (err) {
    if (err instanceof APIError) return NextResponse.json({ error: "Incorrect password" }, { status: 400 });
    throw err;
  }

  const startOk = await checkRateLimit(`email-change-start:${userId}`, EMAIL_CHANGE_START_LIMIT.windowSeconds, EMAIL_CHANGE_START_LIMIT.max);
  if (!startOk) return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });

  // Delete any existing pending change for this user first (same "resend
  // replaces the pending row" pattern as signup/send-otp).
  await db.delete(pendingContactChange).where(and(eq(pendingContactChange.userId, userId), eq(pendingContactChange.type, "EMAIL")));

  // Anti-enumeration (Docs/user/profile.md §5): if newEmail is already taken,
  // respond identically without creating a row or sending an email — the
  // client can't distinguish this from "OTP sent".
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, newEmail)).limit(1);
  if (existing.length === 0) {
    const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");
    await db.insert(pendingContactChange).values({
      userId,
      type: "EMAIL",
      newValue: newEmail,
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
    });
    // Trade-off, deliberate: reporting a delivery failure means that during a mail
    // outage a 502 here reveals the address was free, since the taken branch above
    // always returns 200. Accepted — the alternative is telling the user to check an
    // inbox for a code that was never sent, leaving them permanently stuck. There is
    // no leak while delivery is healthy.
    try {
      await sendEmailChangeOtpEmail(newEmail, otp);
    } catch (err) {
      logServerError("email-change:send-otp", err);
      await db.delete(pendingContactChange).where(and(eq(pendingContactChange.userId, userId), eq(pendingContactChange.type, "EMAIL")));
      return NextResponse.json({ error: "Couldn't send the code. Please try again." }, { status: 502 });
    }
  }

  return NextResponse.json({ success: true });
}
