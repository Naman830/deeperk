import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { RUN_XFF, type FixtureUser } from "../../src/fixtures";
import { adoptSession } from "./session";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Gitignored user-review deliverable — every flow's milestones land here. */
export const ARTIFACTS_DIR = path.resolve(here, "..", "artifacts");

const counters = new Map<string, number>();

/** Numbered milestone screenshot: tests/browser/artifacts/<flow>/<nn>-<step>.png.
 *  A flow's directory is reset on its first shot of the run, so the folder
 *  always holds exactly one run's worth rather than accumulating offsets. */
export async function snap(page: Page, flow: string, step: string): Promise<void> {
  if (!counters.has(flow)) rmSync(path.join(ARTIFACTS_DIR, flow), { recursive: true, force: true });
  const n = (counters.get(flow) ?? 0) + 1;
  counters.set(flow, n);
  await page.screenshot({
    path: path.join(ARTIFACTS_DIR, flow, `${String(n).padStart(2, "0")}-${step}.png`),
  });
}

/**
 * A signed-in context for a REST-seeded fixture user. Manually created
 * contexts do NOT inherit the project's `use` options, so the load-bearing
 * x-forwarded-for header is re-applied here (see playwright.config.ts).
 */
export async function newUserContext(browser: Browser, user: FixtureUser): Promise<BrowserContext> {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": RUN_XFF },
  });
  await adoptSession(context, user);
  return context;
}
