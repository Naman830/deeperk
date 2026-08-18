const { env } = require("./env");

/**
 * The handshake from Docs/chat/chat.md §2.1: one internal HTTP round trip per
 * connection, not a shared JWT secret.
 *
 * Everything is behind this one function on purpose. The cookie strategy is
 * correct for the topologies this app can actually be deployed in *today*
 * (same origin, or same host on a different port), and known-wrong for others
 * — see the note below. Swapping in a token strategy is then a change to this
 * file alone.
 */

const SESSION_URL = `${env.WEB_INTERNAL_URL}/api/auth/get-session`;

function reject(code, message) {
  const error = new Error(message);
  error.data = { code };
  return error;
}

/**
 * COOKIE SCOPE, which is the whole ballgame for this handshake:
 *
 * - Cookies are not port-scoped (RFC 6265 §8.5), and Better Auth sets no
 *   `domain`, so the session cookie IS in the jar for localhost:4000.
 * - SameSite is evaluated per *site*, not origin. :3000 -> :4000 is same-site,
 *   so the default `Lax` does not block it.
 * - But it is still cross-ORIGIN, and engine.io tries HTTP polling first. The
 *   browser only attaches cookies to a cross-origin XHR in credentials mode,
 *   and socket.io-client's `withCredentials` defaults to FALSE. Without it on
 *   the client, this function receives no cookie at all.
 *
 * In production the cookie is host-only, so a sibling subdomain does NOT
 * receive it — same-site is not sufficient. The only topology this is correct
 * for is one origin behind a reverse proxy (/socket.io/ -> :4000). Anything
 * else needs either crossSubDomainCookies (which re-scopes the session cookie
 * app-wide) or a handshake token issued by Next.
 */
async function resolveHandshakeUser(handshake) {
  const cookie = handshake.headers.cookie;
  if (!cookie) return { error: reject("UNAUTHENTICATED", "Not authenticated") };

  let response;
  try {
    response = await fetch(SESSION_URL, {
      // Must be GET: POST on this route is METHOD_NOT_ALLOWED.
      //
      // No Origin header, deliberately. Better Auth's origin check returns
      // early for GET/HEAD/OPTIONS, and an *invented* Origin would then be
      // validated against trustedOrigins — where a wrong guess is a hard 403.
      method: "GET",
      // Forwarded verbatim, never parsed and re-serialized: the value is
      // token + "." + base64(HMAC), and rebuilding it breaks the signature in
      // a way that surfaces as "not logged in" rather than "malformed".
      headers: { cookie, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { error: reject("AUTH_UNAVAILABLE", "Can't reach the server. Try again.") };
  }

  if (!response.ok) return { error: reject("UNAUTHENTICATED", "Not authenticated") };

  const payload = await response.json().catch(() => null);
  const user = payload && payload.user;
  if (!user || !user.id) return { error: reject("UNAUTHENTICATED", "Not authenticated") };

  // get-session happily returns a session for these; getPublicProfile 404s
  // them. Without this check a deletion-scheduled account can chat normally.
  if (user.deactivatedAt || user.deletionScheduledAt) {
    return { error: reject("UNAUTHENTICATED", "Not authenticated") };
  }

  return { user: { id: user.id, username: user.username } };
}

module.exports = { resolveHandshakeUser };
