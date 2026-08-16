import { and, eq, isNull } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user, socialLink, privacySettings } from "../../../../db/schema";
import { avatarUrl } from "@/lib/avatar-url";

export type PublicSocialLink = { id: string; platform: string; url: string };

// Gated fields are ABSENT, not null — callers must branch on key presence.
export type PublicProfile = {
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarPublicId: string | null;
  avatarUrl: string | null;
  isOwner: boolean;
  bio?: string | null;
  socialLinks?: PublicSocialLink[];
  isOnline?: boolean;
  lastSeenAt?: Date | null;
};

/**
 * Public profile view (Docs/user/profile.md — a separate, more restricted query
 * from getOwnProfile, so private fields can't leak by construction).
 *
 * Shared by GET /api/users/[username] and the /u/[username] page so the two can
 * never drift on which fields are gated. Returns null for unknown, deactivated,
 * and deletion-scheduled accounts alike — the caller renders one 404 for all three.
 */
export async function getPublicProfile(username: string, viewerId: string): Promise<PublicProfile | null> {
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
      onlineStatus: privacySettings.onlineStatus,
      profileDetails: privacySettings.profileDetails,
    })
    .from(user)
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(and(eq(user.username, canonicalUsername), isNull(user.deactivatedAt), isNull(user.deletionScheduledAt)))
    .limit(1);
  const row = rows[0];

  if (!row) return null;

  const isOwner = row.id === viewerId;
  // No privacy_settings row yet defaults to EVERYONE, same as the columns' DB default.
  const showDetails = isOwner || (row.profileDetails ?? "EVERYONE") === "EVERYONE";
  const showOnlineStatus = isOwner || (row.onlineStatus ?? "EVERYONE") === "EVERYONE";

  const profile: PublicProfile = {
    username: row.username,
    displayUsername: row.displayUsername,
    firstName: row.firstName,
    lastName: row.lastName,
    avatarPublicId: row.avatarPublicId,
    avatarUrl: avatarUrl(row.avatarPublicId),
    isOwner,
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

  return profile;
}
