import "../../src/env";
import { cleanupAll, countLeftovers } from "../../src/cleanup";
import { config } from "../../src/env";

/**
 * Same preflight contract as the vitest suite's global-setup: both servers
 * must already be running (`npm run dev`), and a crashed prior run's fixtures
 * are swept before anything starts.
 */
export default async function globalSetup(): Promise<void> {
  const session = await fetch(`${config.webUrl}/api/auth/get-session`, {
    headers: { origin: config.webUrl },
  }).catch(() => null);
  if (!session) {
    throw new Error(`Next server not reachable at ${config.webUrl} — start it with 'npm run dev' first`);
  }
  const health = await fetch(`${config.socketUrl}/healthz`)
    .then((res) => res.json())
    .catch(() => null);
  if (!health?.ok) {
    throw new Error(`Socket server not reachable at ${config.socketUrl} — start it with 'npm run dev' first`);
  }
  await cleanupAll();
  const leftovers = await countLeftovers();
  if (leftovers > 0) throw new Error(`cleanup left ${leftovers} zz.e2e. users behind`);
}
