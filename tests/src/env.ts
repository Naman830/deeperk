import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

/**
 * The harness reads the SAME env files the two dev servers read — no secrets
 * are duplicated into tests/. Order matters only for overlapping keys; with
 * override:false the first file that defines a key wins (root .env, which is
 * the superset).
 *
 * MUST be imported before anything that touches src/db.ts — DATABASE_URL has
 * to exist before a Neon client is constructed.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

for (const file of [".env", path.join("server", ".env"), path.join("web", ".env.local")]) {
  dotenv.config({ path: path.join(root, file), override: false, quiet: true });
}

export const config = {
  webUrl: process.env.E2E_WEB_URL ?? "http://localhost:3000",
  socketUrl: process.env.E2E_SOCKET_URL ?? "http://localhost:4000",
  databaseUrl: process.env.DATABASE_URL ?? "",
  internalApiSecret: process.env.INTERNAL_API_SECRET ?? "",
  /** Real, readable inbox for the two flows that genuinely send mail. Optional. */
  testEmail: process.env.TEST_EMAIL,
};

if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is not set — the harness needs the real Neon URL (root .env)");
}
