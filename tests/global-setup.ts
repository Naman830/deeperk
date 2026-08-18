import type { TestProject } from "vitest/node";
import { config } from "./src/env";
import { cleanupAll } from "./src/cleanup";

/**
 * Preflight: both dev servers must already be running (`npm run dev` at the
 * repo root). Booting them here was considered and deferred — see
 * tests/README.md. The bootId captured here is re-asserted in teardown: the
 * socket server's rate limiters are in-memory, so a nodemon restart mid-run
 * silently invalidates limit-adjacent results. Loud failure instead.
 */
export default async function setup(project: TestProject) {
  const webProbe = await fetch(`${config.webUrl}/api/auth/get-session`, {
    headers: { origin: config.webUrl },
  }).catch(() => null);
  if (!webProbe) {
    throw new Error(`Next server not reachable at ${config.webUrl} — start it with 'npm run dev' first`);
  }

  const health = await fetch(`${config.socketUrl}/healthz`)
    .then((res) => res.json())
    .catch(() => null);
  if (!health?.ok || typeof health.bootId !== "string") {
    throw new Error(`Socket server not reachable at ${config.socketUrl}/healthz — start it with 'npm run dev' first`);
  }

  // Sweep leftovers from a crashed prior run before this one seeds anything.
  await cleanupAll();

  project.provide("bootId", health.bootId);

  return async function teardown() {
    await cleanupAll();
    const end = await fetch(`${config.socketUrl}/healthz`)
      .then((res) => res.json())
      .catch(() => null);
    if (!end || end.bootId !== health.bootId) {
      throw new Error(
        `socket server restarted mid-run (bootId ${health.bootId} → ${end?.bootId}); ` +
          `in-memory rate limits reset, so this run's results are unreliable — re-run`,
      );
    }
  };
}
