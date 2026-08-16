import { Resend } from "resend";

// Lazily constructed so importing this module (e.g. from web/src/lib/auth/server.ts,
// which loads at build/type-check/CLI-generate time too, not just at request
// time) never fails just because RESEND_API_KEY isn't set yet — the Resend
// constructor itself throws immediately on a missing key. See web/.env.local.
let resend: Resend | undefined;
function getResendClient(): Resend {
  resend ??= new Resend(process.env.RESEND_API_KEY);
  return resend;
}

const FROM = process.env.RESEND_FROM_EMAIL ?? "ChatSphere <onboarding@resend.dev>";

/** Thrown when Resend refused the send — routes map this to 502, never a silent success. */
export class EmailDeliveryError extends Error {}

/**
 * `emails.send()` RESOLVES with `{ data, error }` instead of throwing, so an
 * unchecked call reports success for an email that was never sent — the user is
 * told "check your inbox" and waits forever for a code that does not exist.
 * Every send goes through here so that can't happen.
 */
async function send(to: string, subject: string, text: string) {
  const { error } = await getResendClient().emails.send({ from: FROM, to, subject, text });
  if (error) throw new EmailDeliveryError(`${error.name}: ${error.message}`);
}

/** Signup OTP (Docs/user/auth.md §2 "Signup") — 6-digit code, 5-minute TTL. */
export async function sendSignupOtpEmail(email: string, otp: string) {
  await send(
    email,
    `${otp} is your ChatSphere verification code`,
    `Your ChatSphere signup verification code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
  );
}

/** Forgot-password OTP (Docs/user/auth.md §2 "Login" → "Forgot password"), via Better Auth's emailOTP plugin in forget-password mode. */
export async function sendForgotPasswordOtpEmail(email: string, otp: string) {
  await send(
    email,
    `${otp} is your ChatSphere password reset code`,
    `Your ChatSphere password reset code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email — your password won't change.`,
  );
}

/** Email-change OTP (Docs/user/profile.md — Email change flow), sent to the NEW address. */
export async function sendEmailChangeOtpEmail(newEmail: string, otp: string) {
  await send(
    newEmail,
    `${otp} is your ChatSphere email verification code`,
    `Your ChatSphere email verification code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
  );
}

/** Notifies the OLD address after a successful email change (Docs/user/profile.md §5). Best-effort, not blocking. */
export async function sendEmailChangedNoticeEmail(oldEmail: string, newEmail: string) {
  await send(
    oldEmail,
    "Your ChatSphere email address was changed",
    `Your ChatSphere account's email was changed to ${newEmail}. If you didn't make this change, contact support immediately.`,
  );
}
