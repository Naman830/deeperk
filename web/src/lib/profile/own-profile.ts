import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user, socialLink, privacySettings } from "../../../../db/schema";
import { avatarUrl } from "@/lib/avatar-url";

export type PrivacyAudience = "EVERYONE" | "NOBODY";

export type OwnPrivacy = {
  discoverable: PrivacyAudience;
  onlineStatus: PrivacyAudience;
  profileDetails: PrivacyAudience;
};

export type OwnProfile = {
  firstName: string;
  lastName: string | null;
  username: string;
  displayUsername: string;
  bio: string | null;
  avatarPublicId: string | null;
  birthDate: string;
  usernameChangedAt: Date | null;
  deletionScheduledAt: Date | null;
  avatarUrl: string | null;
  socialLinks: { id: string; platform: string; url: string }[];
  privacy: OwnPrivacy;
};

// Nothing in signup creates a privacy_settings row, so "no row" is the common
// case and must read as the columns' own DB default.
export const DEFAULT_PRIVACY: OwnPrivacy = {
  discoverable: "EVERYONE",
  onlineStatus: "EVERYONE",
  profileDetails: "EVERYONE",
};

/**
 * Owner's own Settings bundle: profile fields + social links + privacy settings
 * in one round trip. Shared by GET /api/me and the /settings pages.
 */
export async function getOwnProfile(userId: string): Promise<OwnProfile | null> {
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
        usernameChangedAt: user.usernameChangedAt,
        deletionScheduledAt: user.deletionScheduledAt,
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

  if (!profile[0]) return null;

  return {
    ...profile[0],
    avatarUrl: avatarUrl(profile[0].avatarPublicId),
    socialLinks: links,
    privacy: (privacy[0] as OwnPrivacy | undefined) ?? DEFAULT_PRIVACY,
  };
}
