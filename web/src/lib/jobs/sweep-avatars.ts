import { inArray } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../db/schema";
import { AVATAR_FOLDER, destroyAssets, listAssetsByPrefix, type ListedAsset } from "@/lib/integrations/cloudinary";

/**
 * The nightly orphaned-avatar sweep (Docs/user/profile.md §5 — "orphan swept
 * by a nightly cleanup job"). Avatars are unique-per-upload, so replacements
 * and best-effort delete failures both leave orphans behind by design; this
 * job — not the request path — is what reclaims them. It is also the safety
 * net the anonymizer's best-effort Cloudinary step relies on: don't weaken one
 * without revisiting the other.
 */

export type SweepReport = {
  scanned: number;
  deleted: number;
  keptCurrent: number;
  keptRecent: number;
  pages: number;
  hasMore: boolean;
  rateLimitRemaining: number | null;
};

const MAX_PAGES_PER_RUN = 4; // ≤2000 assets/run; leftovers surface next night
export const DEFAULT_RECENT_CUTOFF_MS = 24 * 60 * 60 * 1000;

/**
 * Pure partition of one listing page. `keep` holds the public_ids user rows
 * currently point at — exact-string match, immune to the dynamic-folder-mode
 * public_id caveat, and by construction unable to delete anyone's current
 * avatar. The recency cutoff protects an in-flight upload whose DB write
 * hasn't landed yet (it reads as an orphan for a few seconds); a fresh orphan
 * waiting one extra night is the cheap side of that trade.
 */
export function partitionAvatarAssets(
  assets: ListedAsset[],
  keep: ReadonlySet<string>,
  recentCutoffMs: number,
  now: number,
): { orphans: string[]; keptCurrent: number; keptRecent: number } {
  const orphans: string[] = [];
  let keptCurrent = 0;
  let keptRecent = 0;
  for (const asset of assets) {
    if (keep.has(asset.publicId)) {
      keptCurrent += 1;
    } else if (now - asset.createdAt.getTime() < recentCutoffMs) {
      keptRecent += 1;
    } else {
      orphans.push(asset.publicId);
    }
  }
  return { orphans, keptCurrent, keptRecent };
}

export async function runAvatarSweep(
  options: { maxPages?: number; recentCutoffMs?: number } = {},
): Promise<SweepReport> {
  const maxPages = options.maxPages ?? MAX_PAGES_PER_RUN;
  const recentCutoffMs = options.recentCutoffMs ?? DEFAULT_RECENT_CUTOFF_MS;
  const now = Date.now();

  const report: SweepReport = {
    scanned: 0,
    deleted: 0,
    keptCurrent: 0,
    keptRecent: 0,
    pages: 0,
    hasMore: false,
    rateLimitRemaining: null,
  };

  // The cursor is deliberately not persisted across runs: each night restarts
  // at page 1, and deletions shrink the listing, so a backlog drains anyway.
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const { assets, nextCursor, rateLimitRemaining } = await listAssetsByPrefix(`${AVATAR_FOLDER}/`, {
      nextCursor: cursor,
    });
    report.pages += 1;
    report.rateLimitRemaining = rateLimitRemaining;
    report.scanned += assets.length;

    if (assets.length > 0) {
      // inArray throws on an empty array, hence the guard above.
      const rows = await db
        .select({ avatarPublicId: user.avatarPublicId })
        .from(user)
        .where(
          inArray(
            user.avatarPublicId,
            assets.map((asset) => asset.publicId),
          ),
        );
      const keep = new Set<string>();
      for (const row of rows) if (row.avatarPublicId) keep.add(row.avatarPublicId);

      const { orphans, keptCurrent, keptRecent } = partitionAvatarAssets(assets, keep, recentCutoffMs, now);
      report.keptCurrent += keptCurrent;
      report.keptRecent += keptRecent;
      if (orphans.length > 0) {
        await destroyAssets(orphans);
        report.deleted += orphans.length;
      }
    }

    if (!nextCursor) return report;
    cursor = nextCursor;
  }
  report.hasMore = true;
  return report;
}
