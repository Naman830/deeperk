import { NextResponse } from "next/server";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user, socialLink, privacySettings } from "../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { updateProfileSchema } from "@/lib/validation/profile";
import { avatarUrl } from "@/lib/avatar-url";

// Owner's own Settings-page bundle: profile fields + social links + privacy
// settings in one round trip (Docs/user/profile.md — public view is a
// separate, more restricted query at /api/users/[username]).
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const [profile, links, privacy] = await Promise.all([
    db
      .select({
        firstName: user.firstName,
        lastName: user.lastName,
        username: user.username,
        displayUsername: user.displayUsername,
        bio: user.bio,
        avatarPublicId: user.avatarPublicId,
        birthDate: user.birthDate,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1),
    db.select({ id: socialLink.id, platform: socialLink.platform, url: socialLink.url }).from(socialLink).where(eq(socialLink.userId, userId)),
    db
      .select({ discoverable: privacySettings.discoverable, onlineStatus: privacySettings.onlineStatus, profileDetails: privacySettings.profileDetails })
      .from(privacySettings)
      .where(eq(privacySettings.userId, userId))
      .limit(1),
  ]);

  return NextResponse.json({
    ...profile[0],
    avatarUrl: avatarUrl(profile[0]?.avatarPublicId),
    socialLinks: links,
    privacy: privacy[0] ?? { discoverable: "EVERYONE", onlineStatus: "EVERYONE", profileDetails: "EVERYONE" },
  });
}

// Everyday field edits (Docs/user/profile.md §2, §6: 30/hour/user). Username,
// email, and avatar are NOT editable here — each needs its own dedicated,
// not-yet-built flow (OTP/password step-up or Cloudinary upload).
export async function PATCH(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  const withinLimit = await checkRateLimit(`profile-update:${userId}`, 3600, 30);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const parsed = updateProfileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { firstName, lastName, bio, socialLinks } = parsed.data;

  const fields: Record<string, string | null> = {};
  if (firstName !== undefined) fields.firstName = firstName;
  if (lastName !== undefined) fields.lastName = lastName || null;
  if (bio !== undefined) fields.bio = bio || null;

  if (Object.keys(fields).length > 0) {
    await db.update(user).set({ ...fields, updatedAt: new Date() }).where(eq(user.id, userId));
  }

  // Full replace, not a diff — no transaction (neon-http has none), so this
  // is a known best-effort window, same accepted constraint as elsewhere.
  if (socialLinks !== undefined) {
    await db.delete(socialLink).where(eq(socialLink.userId, userId));
    if (socialLinks.length > 0) {
      await db.insert(socialLink).values(socialLinks.map((link) => ({ userId, platform: link.platform, url: link.url })));
    }
  }

  return NextResponse.json({ success: true });
}
