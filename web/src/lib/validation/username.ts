// Shared username rules (Docs/user/auth.md §4): 3–30 chars, lowercase
// a-z0-9._ only, must start with a letter, must end with a letter/number,
// stored lowercase, unique case-insensitively, reserved-word blocklist.
//
// Length (3–30) is enforced separately by the `username` Better Auth plugin's
// minUsernameLength/maxUsernameLength config (web/src/lib/auth/server.ts) — this file
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
  // Static route segments that would shadow a real handle: /api/users/search
  // wins over /api/users/[username], and /users/* is reserved for the same reason.
  "search",
  "users",
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

// Single source of truth for the live requirements checklist shown under the
// signup username field — each rule is one piece of USERNAME_PATTERN, so the
// checklist and the actual shape check can't drift apart. Reserved-word
// rejection isn't included here (it behaves like "taken", not a shape rule).
export const usernameRequirements = [
  { label: "3–30 characters", test: (v: string) => v.trim().length >= 3 && v.trim().length <= 30 },
  { label: "Starts with a letter", test: (v: string) => /^[a-zA-Z]/.test(v.trim()) },
  { label: "Only letters, numbers, '.' or '_'", test: (v: string) => /^[a-zA-Z0-9._]*$/.test(v.trim()) },
  { label: "Ends with a letter or number", test: (v: string) => /[a-zA-Z0-9]$/.test(v.trim()) },
];
