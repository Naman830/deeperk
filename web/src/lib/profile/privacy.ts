import { eq, isNull, or } from "@/lib/db/drizzle-ops";
import { privacySettings } from "../../../../db/schema";

/**
 * The two privacy gates that more than one feature reads.
 *
 * Extracted for the same reason public-profile.ts and own-profile.ts exist:
 * search, DM creation, group member resolution, the conversation list and the
 * socket server's presence broadcast all have to agree, and four copies of
 * `?? "EVERYONE"` is how they stop agreeing.
 *
 * Nothing at signup creates a privacy_settings row, so **no row is the common
 * case** and must read as EVERYONE — the same value as the column default.
 * Both helpers below encode that; neither treats a missing row as restrictive.
 */

/**
 * SQL predicate for "this user allows me to find them".
 *
 * Requires a `leftJoin(privacySettings, eq(privacySettings.userId, user.id))`
 * on the query — the isNull branch is the missing-row case, not an error case.
 */
export function discoverableFilter() {
  return or(isNull(privacySettings.discoverable), eq(privacySettings.discoverable, "EVERYONE"));
}

/**
 * Whether `isOnline` / `lastSeenAt` may be shown for the row they came from.
 *
 * This is the *subject's* setting, not the viewer's — Docs/chat/chat.md §2.6
 * states it the other way round, but there is no FRIENDS tier (profile.md §3),
 * so the audience is a per-subject boolean and never a per-viewer relation.
 * That is why the socket server can broadcast presence to a whole room instead
 * of filtering per recipient. When a FRIENDS tier lands, this signature has to
 * grow a viewer and that broadcast has to become per-socket.
 */
export function presenceVisible(onlineStatus: string | null | undefined, isOwner = false): boolean {
  return isOwner || (onlineStatus ?? "EVERYONE") === "EVERYONE";
}
