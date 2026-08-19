import { defineConfig, devices } from "@playwright/test";
import { config as env } from "./src/env";
import { RUN_XFF } from "./src/fixtures";

/**
 * Browser-level e2e (tests/browser/*), the follow-up tests/README.md always
 * named. Same operating rules as the vitest suite: an already-running
 * `npm run dev`, the REAL Neon DB, zz.e2e.-prefixed fixtures, cleanup in
 * global setup + teardown. Run with `npm run test:browser` from the root.
 *
 * Serial on purpose, for the vitest suite's reasons: one shared next dev,
 * per-user in-memory socket rate limits, one DB.
 *
 * The x-forwarded-for header is LOAD-BEARING: browser requests carry none, so
 * every IP-keyed bucket (signup-create:<ip> is 3/hr!) would key on 127.0.0.1 —
 * a bucket cleanup never sweeps. RUN_XFF keeps the harness's TEST-NET-3 idiom.
 */

const FAKE_MEDIA_ARGS = [
  // A tone-generating fake mic + auto-granted permission prompts: what lets
  // the voice-note and call flows drive real MediaRecorder/WebRTC headlessly.
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream",
];

export default defineConfig({
  testDir: "./browser",
  outputDir: "./browser/test-results",
  globalSetup: "./browser/support/global-setup.ts",
  globalTeardown: "./browser/support/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: env.webUrl,
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: { "x-forwarded-for": RUN_XFF },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
    {
      name: "mobile",
      // Only specs tagged @mobile run here — the full matrix would double the
      // serial runtime for flows the viewport doesn't change.
      grep: /@mobile/,
      use: {
        ...devices["Pixel 7"],
        launchOptions: { args: FAKE_MEDIA_ARGS },
      },
    },
  ],
});
