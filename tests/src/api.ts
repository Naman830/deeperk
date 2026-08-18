import { config } from "./env";

export type ApiResult = {
  status: number;
  headers: Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  text: string;
};

type RequestInitLite = {
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Explicit null OMITS the Origin header (for the MISSING_OR_NULL_ORIGIN pin). */
  origin?: string | null;
};

/**
 * One instance = one browser session: a cookie jar, a fixed Origin (Better
 * Auth 403s Origin-less requests — negative tests would pass for the wrong
 * reason without it), and a per-run x-forwarded-for so IP-keyed buckets never
 * bleed across runs (TRUSTED_PROXIES is unset locally, so the header is
 * trusted verbatim — deliberate, see CLAUDE.md).
 */
export class ApiClient {
  private cookies = new Map<string, string>();

  constructor(private opts: { xff?: string } = {}) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSession(): boolean {
    return [...this.cookies.keys()].some((name) => name.includes("session_token"));
  }

  private absorbCookies(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0/i.test(line) || /expires=Thu, 01 Jan 1970/i.test(line);
      if (value === "" || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method: string, path: string, init: RequestInitLite = {}): Promise<ApiResult> {
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (init.origin !== null) headers["origin"] = init.origin ?? config.webUrl;
    if (this.opts.xff) headers["x-forwarded-for"] = this.opts.xff;
    if (this.cookies.size > 0) headers["cookie"] = this.cookieHeader();

    let body: BodyInit | undefined;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }

    const res = await fetch(config.webUrl + path, { method, headers, body, redirect: "manual" });
    this.absorbCookies(res);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, body: parsed, text };
  }

  get(path: string, init?: RequestInitLite) {
    return this.request("GET", path, init);
  }
  post(path: string, init?: RequestInitLite) {
    return this.request("POST", path, init);
  }
  patch(path: string, init?: RequestInitLite) {
    return this.request("PATCH", path, init);
  }
  del(path: string, init?: RequestInitLite) {
    return this.request("DELETE", path, init);
  }
}
