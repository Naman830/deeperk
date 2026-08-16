import { NextResponse } from "next/server";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { emailSchema } from "@/lib/validation/signup";

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

  const existing = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);

  return NextResponse.json({ email, exists: existing.length > 0 });
}
