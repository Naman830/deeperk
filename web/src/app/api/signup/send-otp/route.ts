import { randomInt, createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getIp } from "better-auth/api";
import { db } from "@/lib/db";
import { user, pendingRegistration } from "../../../../../../db/schema";
import { emailSchema } from "@/lib/validation/signup";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendSignupOtpEmail } from "@/lib/resend";
import { auth } from "@/lib/auth";

const OTP_TTL_SECONDS = 5 * 60;
const EMAIL_RATE_LIMIT = { windowSeconds: 60 * 60, max: 5 }; // 5/hr per email
const IP_RATE_LIMIT = { windowSeconds: 60 * 60, max: 20 }; // 20/hr per IP

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

// Sends (or resends — deleting any prior row is how resend works, no
// separate endpoint needed) the 6-digit signup OTP. Docs/user/auth.md §2.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = emailSchema.safeParse(body?.email);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  const email = parsed.data;

  // Re-check existence server-side — never trust that the client already
  // did the check-email step (auth.md §2: only that step may reveal this).
  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
  if (existing.length > 0) {
    return NextResponse.json({ error: "Email already exists" }, { status: 409 });
  }

  const ip = getIp(request, auth.options) ?? "unknown";

  const emailOk = await checkRateLimit(`signup-otp-email:${email}`, EMAIL_RATE_LIMIT.windowSeconds, EMAIL_RATE_LIMIT.max);
  if (!emailOk) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }
  const ipOk = await checkRateLimit(`signup-otp-ip:${ip}`, IP_RATE_LIMIT.windowSeconds, IP_RATE_LIMIT.max);
  if (!ipOk) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const otp = randomInt(0, 1_000_000).toString().padStart(6, "0");

  // Delete any existing row for this email first — this is what makes
  // "resend" work with no separate endpoint: calling send-otp again just
  // replaces the pending row with a fresh OTP and a fresh 5-minute window.
  await db.delete(pendingRegistration).where(eq(pendingRegistration.email, email));
  await db.insert(pendingRegistration).values({
    email,
    otpHash: hashOtp(otp),
    expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
  });

  await sendSignupOtpEmail(email, otp);

  return NextResponse.json({ success: true });
}
