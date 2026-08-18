import { createHmac, timingSafeEqual } from "node:crypto";
import type { SendableMessageType } from "./types";

/**
 * A signed claim that "this user uploaded this asset for this conversation".
 *
 * The upload runs in Next and the send runs in the socket server, and they
 * share no row — so without this, `message:send { mediaUrl }` is whatever URL
 * the client feels like. That is arbitrary content injection into every
 * member's DOM and an IP-logging beacon for the whole group. The send handler
 * therefore writes the token's fields and ignores the client's copies entirely.
 *
 * Plain HMAC over node:crypto rather than `jose`, because server/ is CommonJS
 * and has to verify this too. The verifier there is a direct mirror of this
 * file — keep the two in step. A mismatch fails closed (every upload rejected),
 * which is the safe direction.
 */

export type MediaTokenPayload = {
  /** uploader */
  u: string;
  /** conversation */
  c: string;
  /** cloudinary public_id */
  p: string;
  /** delivery url */
  url: string;
  mime: string;
  size: number;
  name: string;
  t: Extract<SendableMessageType, "IMAGE" | "VIDEO" | "FILE">;
  /** expiry, epoch ms */
  exp: number;
};

export const MEDIA_TOKEN_TTL_MS = 10 * 60 * 1000;

export class MediaSigningNotConfiguredError extends Error {}

function getSecret(): string {
  const secret = process.env.MEDIA_SIGNING_SECRET;
  if (!secret) {
    throw new MediaSigningNotConfiguredError("MEDIA_SIGNING_SECRET is not set");
  }
  return secret;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function signMediaToken(payload: MediaTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, getSecret())}`;
}

/** Returns null for any malformed, mis-signed or expired token. */
export function verifyMediaToken(token: unknown): MediaTokenPayload | null {
  if (typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  let expected: string;
  try {
    expected = sign(body, getSecret());
  } catch {
    return null;
  }

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as MediaTokenPayload;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
