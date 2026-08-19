const ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** Thrown when Brevo refused the send — routes map this to 502, never a silent success. */
export class EmailDeliveryError extends Error {}

/**
 * Every send goes through here so a refusal can't read as success — the user
 * being told "check your inbox" for a code that was never sent is the failure
 * this guards against. With plain fetch that means checking `res.ok`; ignoring
 * it is the same class of mistake as discarding Resend's `{ data, error }`.
 *
 * Env is read per-send, not at module load: this module is imported by
 * lib/auth/server.ts, which loads at build/type-check/CLI time too, so nothing
 * here may throw just because the key isn't set yet.
 */
async function send(to: string, subject: string, text: string) {
  const apiKey = process.env.BREVO_API_KEY;
  const email = process.env.BREVO_FROM_EMAIL;
  if (!apiKey || !email) throw new EmailDeliveryError("BREVO_API_KEY / BREVO_FROM_EMAIL are not set");
  const name = process.env.BREVO_FROM_NAME ?? "Deeperk";

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ sender: { name, email }, to: [{ email: to }], subject, textContent: text }),
    // fetch has no default timeout; without this a stalled connection hangs the
    // route handler until the host's own invocation limit kills it.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    // Brevo errors are { code, message }, but a proxy can answer with HTML.
    const body = await res.text().catch(() => "");
    throw new EmailDeliveryError(`Brevo ${res.status}: ${body.slice(0, 300)}`);
  }
}

/** Signup OTP (Docs/user/auth.md §2 "Signup") — 6-digit code, 5-minute TTL. */
export async function sendSignupOtpEmail(email: string, otp: string) {
  await send(
    email,
    `${otp} is your Deeperk verification code`,
    `Your Deeperk signup verification code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
  );
}

/** Forgot-password OTP (Docs/user/auth.md §2 "Login" → "Forgot password"), via Better Auth's emailOTP plugin in forget-password mode. */
export async function sendForgotPasswordOtpEmail(email: string, otp: string) {
  await send(
    email,
    `${otp} is your Deeperk password reset code`,
    `Your Deeperk password reset code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email — your password won't change.`,
  );
}

/** Email-change OTP (Docs/user/profile.md — Email change flow), sent to the NEW address. */
export async function sendEmailChangeOtpEmail(newEmail: string, otp: string) {
  await send(
    newEmail,
    `${otp} is your Deeperk email verification code`,
    `Your Deeperk email verification code is ${otp}. It expires in 5 minutes. If you didn't request this, you can ignore this email.`,
  );
}

/** Notifies the OLD address after a successful email change (Docs/user/profile.md §5). Best-effort, not blocking. */
export async function sendEmailChangedNoticeEmail(oldEmail: string, newEmail: string) {
  await send(
    oldEmail,
    "Your Deeperk email address was changed",
    `Your Deeperk account's email was changed to ${newEmail}. If you didn't make this change, contact support immediately.`,
  );
}
