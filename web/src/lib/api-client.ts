// Thin wrapper over fetch for this app's own /api/* routes, which always answer
// JSON and use `{ error: string }` on failure. Mirrors the local postJson helper
// the signup form already uses, promoted to a shared module now that every
// Settings form needs it.
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
export const apiDelete = <T = Record<string, unknown>>(url: string) => request<T>("DELETE", url);

// Multipart — no Content-Type header, the browser must set its own boundary.
export async function apiUpload<T = Record<string, unknown>>(url: string, form: FormData): Promise<ApiResponse<T>> {
  const res = await fetch(url, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
