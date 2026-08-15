import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { eq } from "@/lib/drizzle-ops";
import { db } from "@/lib/db";
import { pendingRegistration } from "../../../../../../db/schema";
import { emailSchema, otpSchema } from "@/lib/validation/signup";
import { signRegistrationToken, REGISTRATION_TOKEN_COOKIE, REGISTRATION_TOKEN_TTL_SECONDS } from "@/lib/registration-token";

const MAX_ATTEMPTS = 3;

function hashOtp(otp: string): string {
  return createHash("sha256").update(otp).digest("hex");
}

// Verifies the signup OTP and, on success, issues the short-lived
// registration-token cookie that proves "this browser verified this email"
// for the rest of the multi-step signup (Docs/user/auth.md §2).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const emailParsed = emailSchema.safeParse(body?.email);
  const otpParsed = otpSchema.safeParse(body?.otp);
  if (!emailParsed.success || !otpParsed.success) {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  const email = emailParsed.data;
  const otp = otpParsed.data;

  const rows = await db
    .select()
    .from(pendingRegistration)
    .where(eq(pendingRegistration.email, email))
    .limit(1);
  const row = rows[0];

  if (!row || row.expiresAt < new Date()) {
    if (row) await db.delete(pendingRegistration).where(eq(pendingRegistration.email, email));
    return NextResponse.json({ error: "Code expired. Please request a new one." }, { status: 400 });
  }

  if (hashOtp(otp) !== row.otpHash) {
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await db.delete(pendingRegistration).where(eq(pendingRegistration.email, email));
      return NextResponse.json({ error: "Too many incorrect attempts. Please request a new code." }, { status: 400 });
    }
    await db.update(pendingRegistration).set({ attempts }).where(eq(pendingRegistration.email, email));
    return NextResponse.json({ error: "Incorrect code.", attemptsRemaining: MAX_ATTEMPTS - attempts }, { status: 400 });
  }

  await db.delete(pendingRegistration).where(eq(pendingRegistration.email, email));

  const token = await signRegistrationToken(email);
  const cookieStore = await cookies();
  cookieStore.set(REGISTRATION_TOKEN_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: REGISTRATION_TOKEN_TTL_SECONDS,
    path: "/",
  });

  return NextResponse.json({ success: true });
}
