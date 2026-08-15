import { Resend } from "resend";

// Lazily constructed so importing this module (e.g. from web/src/lib/auth.ts,
// which loads at build/type-check/CLI-generate time too, not just at request
// time) never fails just because RESEND_API_KEY isn't set yet — the Resend
// constructor itself throws immediately on a missing key. See web/.env.local.
let resend: Resend | undefined;
function getResendClient(): Resend {
  resend ??= new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const FROM = process.env.RESEND_FROM_EMAIL ?? "ChatSphere <onboarding@resend.dev>";

/** Signup OTP (Docs/user/auth.md §2 "Signup") — 6-digit code, 5-minute TTL. */
export async function sendSignupOtpEmail(email: string, otp: string) {
  await getResendClient().emails.send({
    from: FROM,
    to: email,
    subject: `${otp} is your ChatSphere verification code`,
    text: `Your ChatSphere signup verification code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
  });
}

/** Forgot-password OTP (Docs/user/auth.md §2 "Login" → "Forgot password"), via Better Auth's emailOTP plugin in forget-password mode. */
export async function sendForgotPasswordOtpEmail(email: string, otp: string) {
  await getResendClient().emails.send({
    from: FROM,
    to: email,
    subject: `${otp} is your ChatSphere password reset code`,
    text: `Your ChatSphere password reset code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email — your password won't change.`,
  });
}
