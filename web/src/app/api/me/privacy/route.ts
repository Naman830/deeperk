import { NextResponse } from "next/server";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { privacySettings } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { updatePrivacySchema } from "@/lib/validation/profile";

const DEFAULTS = { discoverable: "EVERYONE", onlineStatus: "EVERYONE", profileDetails: "EVERYONE" } as const;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const rows = await db
    .select({ discoverable: privacySettings.discoverable, onlineStatus: privacySettings.onlineStatus, profileDetails: privacySettings.profileDetails })
    .from(privacySettings)
    .where(eq(privacySettings.userId, session.user.id))
    .limit(1);

  return NextResponse.json(rows[0] ?? DEFAULTS);
}

// No signup step creates a privacy_settings row (only Better Auth's `user`
// row is written at signup completion), so this upserts on first write
// rather than assuming a row already exists — same onConflictDoUpdate
// pattern as rate-limit.ts's atomic upsert, keyed on the unique userId index.
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  // Docs/user/profile.md §6 doesn't list a specific limit for this action;
  // reusing the same 30/hour/user bucket shape as PATCH /api/me.
  const withinLimit = await checkRateLimit(`privacy-update:${userId}`, 3600, 30);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = updatePrivacySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const fields = parsed.data;
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  await db
    .insert(privacySettings)
    .values({ userId, ...fields })
    .onConflictDoUpdate({ target: privacySettings.userId, set: { ...fields, updatedAt: new Date() } });

  return NextResponse.json({ success: true });
}
