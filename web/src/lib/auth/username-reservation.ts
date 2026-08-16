import { and, eq, gt } from "../db/drizzle-ops";
import { db } from "../db";
import { reservedUsername } from "../../../../db/schema";

// Old usernames stay reserved for 30 days.
export const USERNAME_HOLD_DAYS = 30;
const HOLD_MS = USERNAME_HOLD_DAYS * 24 * 60 * 60 * 1000;


// Get the expiry time from the username change time.
export function usernameHoldExpiry(changedAt: Date): Date {
  return new Date(changedAt.getTime() + HOLD_MS);
}

// Return the user holding this username, or null if free.
export async function getUsernameHolder(canonicalUsername: string): Promise<string | null> {
  const rows = await db
    .select({ userId: reservedUsername.userId })
    .from(reservedUsername)
    .where(and(eq(reservedUsername.username, canonicalUsername), gt(reservedUsername.expiresAt, new Date())))
    .limit(1);
  return rows[0]?.userId ?? null;
}

// Reserve a username for 30 days.
export async function holdUsername(canonicalUsername: string, userId: string, changedAt: Date) {
  const expiresAt = usernameHoldExpiry(changedAt);
  await db
    .insert(reservedUsername)
    .values({ username: canonicalUsername, userId, expiresAt })
    .onConflictDoUpdate({ target: reservedUsername.username, set: { userId, expiresAt } });
}
