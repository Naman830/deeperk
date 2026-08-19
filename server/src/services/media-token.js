const { createHmac, timingSafeEqual } = require("node:crypto");
const { env } = require("../config/env");

/**
 * Verifier for the media token minted by POST /api/upload/chat-media.
 *
 * Direct mirror of web/src/lib/chat/media-token.ts — keep the two in step. A
 * mismatch rejects every media message, which is the safe direction to fail.
 *
 * This exists because the upload happens in Next and the send happens here,
 * with no shared row between them. Without it, `message:send { mediaUrl }`
 * accepts any URL the client cares to name: arbitrary content in every
 * member's DOM, and an IP-logging beacon for the whole conversation.
 */
function verifyMediaToken(token) {
  if (typeof token !== "string" || !env.MEDIA_SIGNING_SECRET) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = createHmac("sha256", env.MEDIA_SIGNING_SECRET).update(body).digest("base64url");

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

module.exports = { verifyMediaToken };
