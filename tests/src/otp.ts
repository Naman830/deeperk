import { createHash } from "node:crypto";
import { db, schema, ops } from "./db";

/**
 * OTPs are stored as unsalted sha256 of a 6-digit code (documented in
 * CLAUDE.md's verification-pass notes) — a 10^6 keyspace, brute-forced in
 * ~400ms. This is how OTP-gated flows are driven without an inbox.
 */
export function crackOtp(hashHex: string): string | null {
  for (let n = 0; n < 1_000_000; n++) {
    const code = String(n).padStart(6, "0");
    if (createHash("sha256").update(code).digest("hex") === hashHex) return code;
  }
  return null;
}

export async function readSignupOtp(email: string): Promise<string> {
  const rows = await db
    .select({ otpHash: schema.pendingRegistration.otpHash })
    .from(schema.pendingRegistration)
    .where(ops.eq(schema.pendingRegistration.email, email.toLowerCase()))
    .limit(1);
  if (rows.length === 0) throw new Error(`no pending_registration row for ${email}`);
  const code = crackOtp(rows[0].otpHash);
  if (!code) throw new Error(`could not crack OTP hash for ${email}`);
  return code;
}

export async function readEmailChangeOtp(userId: string): Promise<string> {
  const rows = await db
    .select({ otpHash: schema.pendingContactChange.otpHash })
    .from(schema.pendingContactChange)
    .where(ops.eq(schema.pendingContactChange.userId, userId))
    .limit(1);
  if (rows.length === 0) throw new Error(`no pending_contact_change row for user ${userId}`);
  const code = crackOtp(rows[0].otpHash);
  if (!code) throw new Error(`could not crack OTP hash for user ${userId}`);
  return code;
}
