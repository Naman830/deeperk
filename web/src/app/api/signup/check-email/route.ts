import { NextResponse } from "next/server";
import { getIp } from "better-auth/api";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { emailSchema } from "@/lib/validation/signup";
import { checkRateLimit } from "@/lib/rate-limit";
import { auth } from "@/lib/auth/server";

// Unauthenticated and answers "does this account exist", so without a cap it is a
// free enumeration oracle over the whole user table. Set above send-otp's 20/hr so a
// legitimate typo-and-retry never trips this first.
const CHECK_IP_LIMIT = { windowSeconds: 60 * 60, max: 30 }; // 30/hr per IP

// First step of signup (Docs/user/auth.md §2). This is the ONE screen
// allowed to reveal whether an account already exists — every other
// auth surface (login, forgot-password) must stay non-committal.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const parsed = emailSchema.safeParse(body?.email);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  const email = parsed.data;

  const ip = getIp(request, auth.options) ?? "unknown";
  const withinLimit = await checkRateLimit(`signup-check-email-ip:${ip}`, CHECK_IP_LIMIT.windowSeconds, CHECK_IP_LIMIT.max);
  if (!withinLimit) {
    return NextResponse.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);

  return NextResponse.json({ email, exists: existing.length > 0 });
}
