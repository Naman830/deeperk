import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username, emailOTP } from "better-auth/plugins";
import { createAuthMiddleware, APIError, getIp, getSessionFromCtx } from "better-auth/api";
import { db } from "../db";
import { eq } from "../db/drizzle-ops";
import * as schema from "../../../../db/schema";
import { user as userTable } from "../../../../db/schema";
import { sendForgotPasswordOtpEmail } from "../integrations/brevo";
import { logServerError } from "../log";
import { checkRateLimit } from "../rate-limit";
import { isUsernameAllowed } from "../validation/username";
import { toCanonicalUsername } from "../validation/signup";
import { getUsernameHolder, USERNAME_HOLD_DAYS } from "./username-reservation";

// Rate limits for Better Auth routes.
const LOGIN_RATE_LIMIT = { windowSeconds: 15 * 60, max: 10 }; // 10 / 15min per email+IP
const FORGOT_PASSWORD_RATE_LIMIT = { windowSeconds: 60 * 60, max: 3 }; // 3 / hour per email

// Routes that can receive a username.
const USERNAME_HOLD_PATHS = ["/sign-up/email", "/update-user", "/is-username-available"];
const COOLDOWN_MS = USERNAME_HOLD_DAYS * 24 * 60 * 60 * 1000;

export const auth = betterAuth({
    // Database
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: false, 
    transaction: false,
  }),

  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,

  // DEPLOYMENT PREREQUISITE. getIp() reads `x-forwarded-for`, and with no
  // trustedProxies it trusts a single-value header verbatim — so a client can send
  // its own and bypass every IP-keyed limit (signup-otp-ip, signup-create,
  // signup-verify-ip, signup-check-email-ip, and Better Auth's own limiter).
  // Harmless locally, wide open behind a real proxy. Set TRUSTED_PROXIES to the
  // host's proxy CIDRs at deploy time; the chain is then stripped right-to-left to
  // the first untrusted hop. There is no safe guessable default, which is why this
  // is env-driven rather than hard-coded: disabling IP tracking entirely would be
  // worse, collapsing every caller into one shared bucket.
  advanced: {
    ipAddress: {
      trustedProxies: (process.env.TRUSTED_PROXIES ?? "")
        .split(",")
        .map((cidr) => cidr.trim())
        .filter(Boolean),
    },
  },

  // Password login/reset.
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    maxPasswordLength: 128,
    revokeSessionsOnPasswordReset: true,
  },
  // Extra fields stored on user.
  user: {
    additionalFields: {
      firstName: { type: "string", required: true, input: true },
      lastName: { type: "string", required: false, input: true },
      birthDate: {
        type: "date",
        required: true,
        input: true,
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
        // Better Auth runs this callback through runInBackgroundOrAwait, which
        // catches and only debug-logs, then answers success — so without this a
        // failed send is invisible. Rethrow: the response stays non-committal on
        // purpose (auth.md §5, no account enumeration).
        await sendForgotPasswordOtpEmail(email, otp).catch((err) => {
          logServerError("forgot-password:send-otp", err);
          throw err;
        });
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

      // Docs/user/profile.md §4: a changed-away handle is held 30 days.
      // Checked here rather than in the `username` plugin's usernameValidator
      // because that receives only a bare string — no session, so no way to
      // exempt the handle's own former owner.
      if (USERNAME_HOLD_PATHS.includes(ctx.path)) {
        const raw =
          typeof ctx.body?.username === "string"
            ? ctx.body.username
            : typeof ctx.body?.displayUsername === "string"
              ? ctx.body.displayUsername
              : null;
        const candidate = raw ? toCanonicalUsername(raw) : null;

        // Shape-invalid input never reaches the DB — junk costs zero queries.
        if (candidate && isUsernameAllowed(candidate)) {
          const holderId = await getUsernameHolder(candidate);
          if (holderId) {
            // Only pay for a session read when a hold was actually hit.
            const heldSession = await getSessionFromCtx(ctx).catch(() => null);
            if (heldSession?.user?.id !== holderId) {
              throw new APIError(
                ctx.path === "/is-username-available" ? "UNPROCESSABLE_ENTITY" : "BAD_REQUEST",
                { message: "That username isn't available" },
              );
            }
          }
        }

        // Better Auth's own /update-user accepts { username } straight from any
        // logged-in client, bypassing /api/me/username's cooldown and its
        // usernameChangedAt stamp. Enforce the same 30-day rule here so there's
        // one effective limit. Idempotent with that route, which checks the
        // cooldown BEFORE calling updateUser and stamps AFTER.
        if (candidate && ctx.path === "/update-user") {
          const changeSession = await getSessionFromCtx(ctx).catch(() => null);
          const changerId = changeSession?.user?.id;
          if (changerId) {
            const rows = await db
              .select({ username: userTable.username, usernameChangedAt: userTable.usernameChangedAt })
              .from(userTable)
              .where(eq(userTable.id, changerId))
              .limit(1);
            const changedAt = rows[0]?.usernameChangedAt;
            // A no-op "change" to the handle you already hold isn't a change.
            if (rows[0] && rows[0].username !== candidate && changedAt) {
              if (new Date(changedAt.getTime() + COOLDOWN_MS) > new Date()) {
                throw new APIError("TOO_MANY_REQUESTS", {
                  message: "You can only change your username once every 30 days",
                });
              }
            }
          }
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
