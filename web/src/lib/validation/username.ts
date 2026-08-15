// Shared username rules (Docs/user/auth.md §4): 3–30 chars, lowercase
// a-z0-9._ only, must start with a letter, must end with a letter/number,
// stored lowercase, unique case-insensitively, reserved-word blocklist.
//
// Length (3–30) is enforced separately by the `username` Better Auth plugin's
// minUsernameLength/maxUsernameLength config (web/src/lib/auth.ts) — this file
// only owns the character-shape rule and the reserved-word list, so both the
// plugin's usernameValidator and any custom (unauthenticated, pre-signup)
// check-username route share exactly one source of truth.

export const USERNAME_PATTERN = /^[a-z][a-z0-9._]*[a-z0-9]$/;

export const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "support",
  "api",
  "system",
  "login",
  "signup",
  "settings",
  "help",
  "about",
  "contact",
  "null",
  "undefined",
  "chatsphere",
]);

export function isValidUsernameShape(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.toLowerCase());
}

export function isUsernameAllowed(username: string): boolean {
  return isValidUsernameShape(username) && !isReservedUsername(username);
}
