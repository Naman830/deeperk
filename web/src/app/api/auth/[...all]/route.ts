import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";

// Catch-all for every Better Auth-owned endpoint: session validation/refresh,
// sign-in/sign-out, the emailOTP plugin's forget-password endpoints, and the
// username plugin's availability check. Our custom OTP signup flow
// (web/src/app/api/signup/*) deliberately lives outside this catch-all —
// decision #1, see /home/naman/.claude/plans (Better Auth integration plan).
export const { GET, POST } = toNextJsHandler(auth);
