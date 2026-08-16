import { SignJWT, jwtVerify } from "jose";

// Short-lived proof that "this browser verified this email" (Docs/user/auth.md
// §2 "Signup"), issued right after a correct signup OTP and consumed once by
// /api/signup/complete. Reuses BETTER_AUTH_SECRET as the signing key — this
// token never touches Better Auth itself, but there's no reason to manage a
// second secret for a token this narrowly scoped and short-lived.
const COOKIE_NAME = "registration_token";
const TTL_SECONDS = 15 * 60;

function getSigningKey() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function signRegistrationToken(email: string): Promise<string> {
  return new SignJWT({ email, purpose: "registration" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(getSigningKey());
}

/** Returns the verified email, or null if the token is missing/invalid/expired. */
export async function verifyRegistrationToken(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSigningKey());
    if (payload.purpose !== "registration" || typeof payload.email !== "string") {
      return null;
    }
    return payload.email;
  } catch {
    return null;
  }
}

export const REGISTRATION_TOKEN_COOKIE = COOKIE_NAME;
export const REGISTRATION_TOKEN_TTL_SECONDS = TTL_SECONDS;
