import { z } from "zod";
import { firstNameSchema, lastNameSchema } from "./signup";

// Field rules per Docs/user/profile.md §4. firstName/lastName reuse
// validation/signup.ts (identical rules there) rather than redefining them.
export { firstNameSchema, lastNameSchema };

// Plain text, no links (bio is always rendered escaped, never as HTML).
const URL_LIKE = /(https?:\/\/|www\.)\S+/i;
export const bioSchema = z
  .string()
  .trim()
  .max(250, "Bio must be 250 characters or fewer")
  .refine((value) => !URL_LIKE.test(value), "Bio can't contain links")
  .optional()
  .or(z.literal(""));

export const socialLinkSchema = z.object({
  platform: z.string().trim().min(1, "Platform is required").max(50),
  url: z.string().trim().url("Enter a valid URL").regex(/^https?:\/\//i, "URL must start with http:// or https://"),
});

// Max 4 links/user, enforced here (app layer) — not a DB constraint.
export const socialLinksArraySchema = z.array(socialLinkSchema).max(4, "You can add up to 4 social links");

export const updateProfileSchema = z.object({
  firstName: firstNameSchema.optional(),
  lastName: lastNameSchema,
  bio: bioSchema,
  socialLinks: socialLinksArraySchema.optional(),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

// discoverable / onlineStatus / profileDetails — no FRIENDS tier yet (no
// relationship graph), so plain EVERYONE/NOBODY per Docs/user/profile.md §3.
export const privacyAudienceSchema = z.enum(["EVERYONE", "NOBODY"]);

export const updatePrivacySchema = z.object({
  discoverable: privacyAudienceSchema.optional(),
  onlineStatus: privacyAudienceSchema.optional(),
  profileDetails: privacyAudienceSchema.optional(),
});

export type UpdatePrivacyInput = z.infer<typeof updatePrivacySchema>;
