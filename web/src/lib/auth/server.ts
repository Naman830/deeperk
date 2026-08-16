import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username, emailOTP } from "better-auth/plugins";
import { createAuthMiddleware, APIError, getIp } from "better-auth/api";
import { db } from "./db";
import * as schema from "../../../db/schema";
import { sendForgotPasswordOtpEmail } from "./resend";
import { checkRateLimit } from "./rate-limit";
import { isUsernameAllowed } from "./validation/username";

// Docs/user/auth.md §6 rate limits that live on Better Auth's own paths.
// (Signup's email/OTP/account-creation limits are on OUR custom
// /api/signup/* routes — decision #1 — and are checked there directly,
// not here.)
const LOGIN_RATE_LIMIT = { windowSeconds: 15 * 60, max: 10 }; // 10 / 15min per email+IP
const FORGOT_PASSWORD_RATE_LIMIT = { windowSeconds: 60 * 60, max: 3 }; // 3 / hour per email

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: false, // our tables are singular: user, account, session, verification
    // Neon's neon-http driver (db/index.js) has NO transaction support at all
    // ("No transactions support in neon-http driver" — verified against the
    // installed drizzle-orm build). Leaving this false (the default) is not
    // a missed optimization, it's the only option this driver allows.
    transaction: false,
  }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    // "A successful reset revokes all other active sessions" (auth.md §2) —
    // this single flag is honored by both the base /reset-password flow AND
    // the emailOTP plugin's /email-otp/reset-password handler (verified
    // directly against the installed plugin's source).
    revokeSessionsOnPasswordReset: true,
    // Composition rules beyond length (upper/lower/number, no spaces) aren't
    // expressible here — enforced by the shared zod password schema
    // (web/src/lib/validation/password.ts) both client-side and again on our
    // /api/signup/complete route before signUpEmail is ever called.
  },

  user: {
    additionalFields: {
      // Not user-facing at signup: computed server-side from firstName/lastName.
      firstName: { type: "string", required: true, input: true },
      lastName: { type: "string", required: false, input: true },
      birthDate: {
        type: "date",
        required: true,
        input: true,
        // Better Auth's "date" field type is always a JS Date internally
        // (the CLI generator maps it to a `timestamp` column, confirmed by
        // running `@better-auth/cli generate` against this config). Our
        // `birth_date` column is intentionally a date-only Postgres `date`
        // column, not `timestamp` (CLAUDE.md: "birthDate is date, no
        // time-of-day meaning") — Drizzle's `date()` column, unconfigured,
        // reads/writes it as a "YYYY-MM-DD" *string*, not a Date object.
        // This transform bridges that gap on the way in.
        transform: {
          input: (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value),
        },
      },
      bio: { type: "string", required: false, input: false },
      avatarPublicId: { type: "string", required: false, input: false },
      usernameChangedAt: { type: "date", required: false, input: false },
      deactivatedAt: { type: "date", required: false, input: false },
      deletionScheduledAt: { type: "date", required: false, input: false },
      isOnline: { type: "boolean", required: false, input: false, defaultValue: false },
      lastSeenAt: { type: "date", required: false, input: false },
    },
  },

  // Our custom signup flow (decision #1) already verified the email via OTP
  // before /api/signup/complete ever calls signUpEmail — force emailVerified
  // true unconditionally. Safe: this is the ONLY signup path in the app, so
  // there's no other caller this could wrongly affect.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          return { data: { ...user, emailVerified: true } };
        },
      },
    },
  },

  plugins: [
    username({
      minUsernameLength: 3,
      maxUsernameLength: 30,
      // Character-shape + reserved-word rules (auth.md §4), shared with the
      // pre-signup check-username route so both paths agree.
      usernameValidator: (value) => isUsernameAllowed(value),
    }),

    // Forget-password OTP ONLY (decision #2). Signup verification never
    // touches this plugin — `sendVerificationOnSignUp` is left at its
    // default `false`, and the callback below no-ops for every OTP type
    // except "forget-password" as a second, explicit boundary.
    emailOTP({
      otpLength: 6,
      expiresIn: 60 * 5, // 5 minutes, matching the rest of the app's OTP TTL
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "forget-password") {
          // Should be unreachable: sign-in/email-verification/change-email
          // OTP flows are never invoked by this app's client.
          throw new Error(`Unexpected email OTP type "${type}" — this app only issues forget-password OTPs`);
        }
        await sendForgotPasswordOtpEmail(email, otp);
      },
    }),
  ],

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-in/email") {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.toLowerCase() : "unknown";
        const ip = getIp(ctx.request ?? ctx.headers ?? new Headers(), ctx.context.options) ?? "unknown";
        const ok = await checkRateLimit(`login:${email}:${ip}`, LOGIN_RATE_LIMIT.windowSeconds, LOGIN_RATE_LIMIT.max);
        if (!ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many login attempts. Please try again later.",
          });
        }
      }

      if (ctx.path === "/email-otp/request-password-reset") {
        const email = typeof ctx.body?.email === "string" ? ctx.body.email.toLowerCase() : "unknown";
        const ok = await checkRateLimit(
          `forgot-password:${email}`,
          FORGOT_PASSWORD_RATE_LIMIT.windowSeconds,
          FORGOT_PASSWORD_RATE_LIMIT.max,
        );
        if (!ok) {
          throw new APIError("TOO_MANY_REQUESTS", {
            message: "Too many reset requests. Please try again later.",
          });
        }
      }
    }),
    // No `after` normalization needed: Better Auth's own /sign-in/email
    // handler already throws the identical INVALID_EMAIL_OR_PASSWORD error
    // for "user not found", "no credential account", "no password set", AND
    // "wrong password" (verified against the installed route source) — the
    // doc's "never leak account existence via a failed login" requirement is
    // already satisfied by Better Auth's default behavior.
  },
});
