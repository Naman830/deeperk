import { z } from "zod";
import { isUsernameAllowed } from "./username";

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

// Validated against its lowercased form (the char-shape rule is
// case-insensitive on input), but NOT lowercased itself — the raw trimmed
// value is what becomes `displayUsername` ("typed case preserved" per
// Docs/database/schema.md); `toCanonicalUsername()` below derives the
// lowercase, unique `username` column from it.
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be 30 characters or fewer")
  .refine((value) => isUsernameAllowed(value.toLowerCase()), {
    message:
      "Usernames must start with a letter, end with a letter or number, and contain only letters, numbers, '.' or '_'",
  });

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

export const signupCompleteSchema = z.object({
  firstName: firstNameSchema,
  lastName: lastNameSchema,
  username: usernameSchema,
  birthDate: birthDateSchema,
  password: passwordSchema,
});

export type SignupCompleteInput = z.infer<typeof signupCompleteSchema>;
