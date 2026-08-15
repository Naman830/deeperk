import { createAuthClient } from "better-auth/react";
import { usernameClient, emailOTPClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  plugins: [usernameClient(), emailOTPClient()],
});

export const { signIn, signOut, useSession } = authClient;

// Used by the signup flow's live username-availability step
// (web/src/app/signup/page.tsx) — the `username` plugin exposes this as a
// public endpoint (no session required), which is exactly the unauthenticated
// mid-onboarding check this app needs.
export const isUsernameAvailable = authClient.isUsernameAvailable;

// Forgot-password flow (web/src/app/login/forgot-password/page.tsx), via the
// emailOTP plugin's forget-password mode (decision #2) — never the
// deprecated /forget-password/email-otp endpoint.
export const requestPasswordResetOtp = authClient.emailOtp.requestPasswordReset;
export const resetPasswordWithOtp = authClient.emailOtp.resetPassword;
