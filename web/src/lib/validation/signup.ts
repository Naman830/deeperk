import { z } from "zod";
import { isValidUsernameShape, isReservedUsername } from "./username";

// Field rules per Docs/user/auth.md §4. Shared between client-side (inline
// feedback) and server-side re-validation (route handlers never trust that
// client-side validation already ran).

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email("Enter a valid email address");

export const otpSchema = z
  .string()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

export const firstNameSchema = z
  .string()
  .trim()
  .min(1, "First name is required")
  .max(25, "First name must be 25 characters or fewer");

export const lastNameSchema = z
  .string()
  .trim()
  .max(25, "Last name must be 25 characters or fewer")
  .optional()
  .or(z.literal(""));

const USERNAME_SHAPE_MESSAGE =
  "Usernames must start with a letter, end with a letter or number, and contain only letters, numbers, '.' or '_'";
const USERNAME_RESERVED_MESSAGE = "That username isn't available";

// Validated against its lowercased form (the char-shape rule is
// case-insensitive on input), but NOT lowercased itself — the raw trimmed
// value is what becomes `displayUsername` ("typed case preserved" per
// Docs/database/schema.md); `toCanonicalUsername()` below derives the
// lowercase, unique `username` column from it.
//
// Shape and reserved-word are separate refines (not the combined
// isUsernameAllowed()) so each gets its own message — the shape one is
// suppressed at submit time in favor of the live checklist (usernameRequirements),
// but the reserved-word one isn't, since a reserved word can pass every
// checklist rule and still need its own explanation.
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be 30 characters or fewer")
  .refine((value) => isValidUsernameShape(value.toLowerCase()), { message: USERNAME_SHAPE_MESSAGE })
  .refine((value) => !isReservedUsername(value), { message: USERNAME_RESERVED_MESSAGE });

// Messages already represented in `usernameRequirements`'s live checklist.
const USERNAME_CHECKLIST_COVERED_MESSAGES = new Set([
  "Username must be at least 3 characters",
  "Username must be 30 characters or fewer",
  USERNAME_SHAPE_MESSAGE,
]);

// Mirrors getPasswordSubmitError: only returns an error string for failures
// the live checklist doesn't already cover (currently just the reserved-word case).
export function getUsernameSubmitError(username: string): string | undefined {
  const parsed = usernameSchema.safeParse(username);
  if (parsed.success) return undefined;
  return parsed.error.issues.find((issue) => !USERNAME_CHECKLIST_COVERED_MESSAGES.has(issue.message))?.message;
}

export function toCanonicalUsername(displayUsername: string): string {
  return displayUsername.trim().toLowerCase();
}

// Real date, age >= 13 (auth.md §4).
export const birthDateSchema = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Enter a valid date")
  .refine((value) => {
    const dob = new Date(value);
    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const hasHadBirthdayThisYear =
      today.getMonth() > dob.getMonth() ||
      (today.getMonth() === dob.getMonth() && today.getDate() >= dob.getDate());
    if (!hasHadBirthdayThisYear) age -= 1;
    return age >= 13;
  }, "You must be at least 13 years old");

// 10–128 chars, >=1 upper/lower/number, special optional, no spaces.
export const passwordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(128, "Password must be 128 characters or fewer")
  .regex(/^\S+$/, "Password cannot contain spaces")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/[0-9]/, "Password must contain a number");

// Single source of truth for the live requirements checklist shown under
// password-creation fields (signup, reset). Keep in sync with the regex
// rules above by hand — these deliberately omit the "no spaces"/128-char-max
// rules, which stay submit-time-only errors rather than checklist items.
export const passwordRequirements = [
  { label: "At least 10 characters", test: (v: string) => v.length >= 10 },
  { label: "One uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "One lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { label: "One number", test: (v: string) => /[0-9]/.test(v) },
];

// Messages already represented in `passwordRequirements`, so a submit-time
// error banner doesn't restate what the live checklist already shows.
const CHECKLIST_COVERED_MESSAGES = new Set([
  "Password must be at least 10 characters",
  "Password must contain a lowercase letter",
  "Password must contain an uppercase letter",
  "Password must contain a number",
]);

// Validates a password for submit, but only returns an error string for
// failures the live checklist doesn't already cover (e.g. spaces, too long).
export function getPasswordSubmitError(password: string): string | undefined {
  const parsed = passwordSchema.safeParse(password);
  if (parsed.success) return undefined;
  return parsed.error.issues.find((issue) => !CHECKLIST_COVERED_MESSAGES.has(issue.message))?.message;
}

export const signupCompleteSchema = z.object({
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  username: usernameSchema,
  birthDate: birthDateSchema,
  password: passwordSchema,
});

export type SignupCompleteInput = z.infer<typeof signupCompleteSchema>;
