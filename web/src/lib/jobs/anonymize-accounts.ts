import { createHash } from "node:crypto";
import { and, asc, eq, isNotNull, lt } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import {
  account,
  pendingContactChange,
  privacySettings,
  reservedUsername,
  session as sessionTable,
  socialLink,
  user,
} from "../../../../db/schema";
import { AVATAR_FOLDER, deleteEmptyFolder, destroyAssetsByPrefix } from "@/lib/integrations/cloudinary";
import { logServerError } from "@/lib/log";

/**
 * The nightly account anonymizer (Docs/user/profile.md — Delete Account:
 * "Nightly job anonymizes the profile, message TEXT kept as 'Deleted User'").
 * The user row is rewritten in place, never deleted — every RESTRICT FK from
 * history tables (messages, calls, memberships) keeps resolving forever.
 *
 * neon-http has no transactions, so the per-user pipeline is ordered for
 * crash-resumability instead: the deletionScheduledAt stamp survives until the
 * final DB step, keeping a half-processed user in the next run's candidate
 * set, and every step is idempotent.
 */

export type AnonymizerReport = {
  anonymized: number;
  skipped: number;
  reservedUsernamesSwept: number;
  cloudinaryErrors: number;
  hasMore: boolean;
};

const MAX_USERS_PER_RUN = 10;

/**
 * The replacement row, derived deterministically from the user id so a re-run
 * writes identical values (idempotent under the unique indexes). sha256 rather
 * than the id itself: Better Auth ids are mixed-case base62, and lowercasing
 * one to fit the username charset could collide two ids differing only by case.
 */
export function anonymizedUserFields(userId: string, now: Date) {
  const hex = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  const handle = `deleted.${hex}`; // 24 chars, legal under the username shape rules
  return {
    email: `${handle}@anonymized.invalid`, // RFC 2606 — can never receive mail
    emailVerified: false,
    name: "Deleted User", // profile.md's phrase; the stored name IS what renders
    firstName: "Deleted",
    lastName: null,
    username: handle,
    displayUsername: handle,
    birthDate: "1970-01-01", // NOT NULL date column; epoch reads as a sentinel
    bio: null,
    avatarPublicId: null,
    usernameChangedAt: null,
    // The permanent "hidden" marker — every gate that hides deletion-scheduled
    // accounts (search, public profile, socket auth) already checks it.
    deactivatedAt: now,
    isOnline: false,
    lastSeenAt: null,
    updatedAt: now,
  };
}

export async function runAccountAnonymizer(options: { maxUsers?: number } = {}): Promise<AnonymizerReport> {
  const maxUsers = options.maxUsers ?? MAX_USERS_PER_RUN;
  const now = new Date();

  // The stamp IS the due date (api/me/delete stores now + 30d), so the
  // predicate is a plain "has passed" — comparing against now - 30d instead
  // would silently double the grace period to 60 days.
  const due = await db
    .select({ id: user.id })
    .from(user)
    .where(and(isNotNull(user.deletionScheduledAt), lt(user.deletionScheduledAt, now)))
    .orderBy(asc(user.deletionScheduledAt))
    .limit(maxUsers + 1);

  const report: AnonymizerReport = {
    anonymized: 0,
    skipped: 0,
    reservedUsernamesSwept: 0,
    cloudinaryErrors: 0,
    hasMore: due.length > maxUsers,
  };

  for (const { id } of due.slice(0, maxUsers)) {
    // Sessions FIRST: with no session rows, getSession() can never again fire
    // its cancel-on-login clear for this user — and the still-set stamp keeps
    // the user in next night's candidate set if the process dies below.
    await db.delete(sessionTable).where(eq(sessionTable.userId, id));

    // The commit point. Conditional + returning: a cancel that landed between
    // the candidate SELECT and here matches zero rows and nothing below runs.
    const updated = await db
      .update(user)
      .set(anonymizedUserFields(id, now))
      .where(and(eq(user.id, id), isNotNull(user.deletionScheduledAt), lt(user.deletionScheduledAt, now)))
      .returning({ id: user.id });
    if (updated.length === 0) {
      report.skipped += 1;
      continue;
    }

    // Companion rows only CASCADE on a hard user-delete, which never happens,
    // so each is scrubbed explicitly. account first: it holds the scrypt hash.
    await db.delete(account).where(eq(account.userId, id));
    await Promise.all([
      db.delete(socialLink).where(eq(socialLink.userId, id)),
      db.delete(privacySettings).where(eq(privacySettings.userId, id)),
      db.delete(pendingContactChange).where(eq(pendingContactChange.userId, id)),
      db.delete(reservedUsername).where(eq(reservedUsername.userId, id)),
    ]);
    // Deliberately untouched: RESTRICT history tables, block rows (a block is
    // a safety record), and verification rows (self-expiring, not user-keyed).

    // Terminal marker, only after every DB scrub succeeded — clearing the
    // stamp is what removes the user from future candidate sets.
    await db.update(user).set({ deletionScheduledAt: null }).where(eq(user.id, id));

    // Best-effort: a Cloudinary outage must not re-queue the user forever.
    // Anything left behind is an orphan by definition (avatarPublicId is null
    // now) and the nightly sweep-avatars job is the designed net for it.
    try {
      await destroyAssetsByPrefix(`${AVATAR_FOLDER}/${id}/`);
      await deleteEmptyFolder(`${AVATAR_FOLDER}/${id}`);
    } catch (err) {
      report.cloudinaryErrors += 1;
      logServerError("cron:anonymize-accounts:cloudinary", err);
    }

    report.anonymized += 1;
  }

  // Expired username holds: reads filter on expires_at, and the public
  // availability route must never write, so this sweep is the sanctioned
  // deleter (CLAUDE.md — Username hold). The freed handle gets no new hold:
  // the hold rule is about renames, and this user's grace period already ran.
  const swept = await db
    .delete(reservedUsername)
    .where(lt(reservedUsername.expiresAt, now))
    .returning({ id: reservedUsername.id });
  report.reservedUsernamesSwept = swept.length;

  return report;
}
