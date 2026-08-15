import { NextResponse } from "next/server";
import { and, eq, isNull } from "@/lib/drizzle-ops";
import { db } from "@/lib/db";
import { user, socialLink, privacySettings } from "../../../../../../db/schema";
import { getSession } from "@/lib/get-session";

// Public profile view (Docs/user/profile.md — separate, more restricted
// query from GET /api/me, so private fields can't leak by construction).
// Requires a session, per Docs/user/search.md's "any authenticated user can
// view any public profile" model — no anonymous access.
export async function GET(_request: Request, { params }: { params: Promise<{ username: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { username } = await params;
  const canonicalUsername = username.trim().toLowerCase();

  const rows = await db
    .select({
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      username: user.username,
      displayUsername: user.displayUsername,
      bio: user.bio,
      avatarPublicId: user.avatarPublicId,
      isOnline: user.isOnline,
      lastSeenAt: user.lastSeenAt,
      discoverable: privacySettings.discoverable,
      onlineStatus: privacySettings.onlineStatus,
      profileDetails: privacySettings.profileDetails,
    })
    .from(user)
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(and(eq(user.username, canonicalUsername), isNull(user.deactivatedAt), isNull(user.deletionScheduledAt)))
    .limit(1);
  const row = rows[0];

  if (!row) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const isOwner = row.id === session.user.id;
  // No privacy_settings row yet defaults to EVERYONE, same as the columns' DB default.
  const showDetails = isOwner || (row.profileDetails ?? "EVERYONE") === "EVERYONE";
  const showOnlineStatus = isOwner || (row.onlineStatus ?? "EVERYONE") === "EVERYONE";

  const profile: Record<string, unknown> = {
    username: row.username,
    displayUsername: row.displayUsername,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarPublicId: row.avatarPublicId,
  };

  if (showDetails) {
    profile.bio = row.bio;
    profile.socialLinks = await db
      .select({ id: socialLink.id, platform: socialLink.platform, url: socialLink.url })
      .from(socialLink)
      .where(eq(socialLink.userId, row.id));
  }

  if (showOnlineStatus) {
    profile.isOnline = row.isOnline;
    profile.lastSeenAt = row.lastSeenAt;
  }

  return NextResponse.json(profile);
}
