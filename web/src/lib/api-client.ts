// Thin wrapper over fetch for this app's own /api/* routes, which always answer
// JSON and use `{ error: string }` on failure. The single place this app talks to
// its own API — don't hand-roll a fetch alongside it.
export type ApiResponse<T = Record<string, unknown>> = {
  ok: boolean;
  status: number;
  data: T & { error?: string };
};

// A network-level fetch rejection (connection drop, DNS) answers as
// { ok: false, status: 0 } instead of throwing — every caller already handles
// ok:false inline, and an escaping rejection is a silent no-op in the UI.
const NETWORK_FAILURE = { error: "Couldn't reach the server. Check your connection and try again." };

async function request<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<ApiResponse<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch {
    return { ok: false, status: 0, data: NETWORK_FAILURE as ApiResponse<T>["data"] };
  }
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
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", body: form });
  } catch {
    return { ok: false, status: 0, data: NETWORK_FAILURE as ApiResponse<T>["data"] };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
