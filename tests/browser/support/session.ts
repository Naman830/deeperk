import type { BrowserContext } from "@playwright/test";
import type { FixtureUser } from "../../src/fixtures";
import { config } from "../../src/env";

/**
 * Adopts a REST-seeded fixture user's session into a browser context: fixture
 * creation goes through Better Auth's sign-up (auto-signs-in into the
 * ApiClient's jar), and the browser only needs the same cookies. Spares every
 * spec the login form — the login flow itself is covered once, explicitly.
 */
export async function adoptSession(context: BrowserContext, user: FixtureUser): Promise<void> {
  const url = new URL(config.webUrl);
  const cookies = user.api
    .cookieHeader()
    .split("; ")
    .filter(Boolean)
    .map((pair) => {
      const separator = pair.indexOf("=");
      return {
        name: pair.slice(0, separator),
        value: pair.slice(separator + 1),
        domain: url.hostname,
        path: "/",
      };
    });
  if (cookies.length === 0) throw new Error("fixture user has no session cookies to adopt");
  await context.addCookies(cookies);
}
