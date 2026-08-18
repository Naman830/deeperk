/**
 * Server-side error logging for failures we deliberately swallow.
 *
 * Routes map third-party failures to a generic status + message so nothing
 * internal leaks to the client. That's correct, but it previously meant the real
 * cause vanished entirely — `web/src` had no logging at all, which is how a
 * refused email send reported success for weeks and how a Cloudinary 403 surfaced
 * only as "Upload failed. Please try again."
 *
 * Only ever called from route handlers and server modules, so this writes to the
 * server log and never reaches the browser. Deliberately console.error rather than
 * a logging dependency — there's no log aggregation in this project yet, and the
 * dev server and any host both capture stderr.
 */
export function logServerError(scope: string, error: unknown): void {
  console.error(`[${scope}]`, describe(error));
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  // Not everything rejects with an Error. The Cloudinary SDK rejects with a plain
  // { message, http_code, name } object, which String() renders as the useless
  // "[object Object]" — the exact failure this module exists to prevent.
  if (error !== null && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}
