// Thin wrapper over fetch for this app's own /api/* routes, which always answer
// JSON and use `{ error: string }` on failure. The single place this app talks to
// its own API — don't hand-roll a fetch alongside it.
export type ApiResponse<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T & { error?: string };
};

async function request<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<ApiResponse<T>> {
  const res = await fetch(url, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const apiPost = <T = Record<string, unknown>>(url: string, body?: unknown) => request<T>("POST", url, body);
export const apiPatch = <T = Record<string, unknown>>(url: string, body?: unknown) => request<T>("PATCH", url, body);
// DELETE takes an optional body. Unusual, but "clear chat" and "delete chat"
// are the same idempotent removal differing only by scope, and splitting them
// into two routes to avoid a body would be worse.
export const apiDelete = <T = Record<string, unknown>>(url: string, body?: unknown) =>
  request<T>("DELETE", url, body);

// Multipart — no Content-Type header, the browser must set its own boundary.
export async function apiUpload<T = Record<string, unknown>>(url: string, form: FormData): Promise<ApiResponse<T>> {
  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
