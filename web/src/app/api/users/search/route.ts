import { NextResponse } from "next/server";
import { and, asc, eq, ilike, isNull, ne } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user, privacySettings } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { discoverableFilter } from "@/lib/profile/privacy";
import { notBlockedWith } from "@/lib/social/block";
import { avatarUrl } from "@/lib/avatar-url";
import { searchQuerySchema, escapeLikePattern, SEARCH_RESULT_LIMIT } from "@/lib/validation/search";

// Search-to-message (Docs/user/search.md): prefix match on username only,
// gated by the target's `discoverable` setting. This route is the sole consumer
// of privacy_settings.discoverable.
//
// NOTE: this static segment shadows /api/users/[username], which is why
// "search" is in RESERVED_USERNAMES (web/src/lib/validation/username.ts).
export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  // §4: a sub-2-char query is "nothing to search", not a bad request — the
  // client never sends one, and a stray one shouldn't read as an error.
  const parsed = searchQuerySchema.safeParse(new URL(request.url).searchParams.get("q") ?? "");
  if (!parsed.success) return NextResponse.json({ results: [] });

  // §6: 20/minute — read-only and already debounced client-side; the limit only
  // stops someone scripting the endpoint directly.
  const withinLimit = await checkRateLimit(`user-search:${userId}`, 60, 20);
  if (!withinLimit) return NextResponse.json({ error: "Slow down." }, { status: 429 });

  const rows = await db
    .select({
      username: user.username,
      displayUsername: user.displayUsername,
      firstName: user.firstName,
      lastName: user.lastName,
      avatarPublicId: user.avatarPublicId,
    })
    .from(user)
    .leftJoin(privacySettings, eq(privacySettings.userId, user.id))
    .where(
      and(
        ilike(user.username, `${escapeLikePattern(parsed.data)}%`),
        ne(user.id, userId),
        isNull(user.deactivatedAt),
        isNull(user.deletionScheduledAt),
        // Shared with chat's DM/group gates so the three can't drift.
        discoverableFilter(),
        // Blocking hides you from search in BOTH directions — a predicate, not
        // a post-filter, or the LIMIT would silently return a short page.
        notBlockedWith(userId),
      ),
    )
    .orderBy(asc(user.username))
    .limit(SEARCH_RESULT_LIMIT);

  return NextResponse.json({
    results: rows.map((row) => ({ ...row, avatarUrl: avatarUrl(row.avatarPublicId, 96) })),
  });
}
