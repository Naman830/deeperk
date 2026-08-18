import { createRequire } from "node:module";
import { config } from "./env";

/**
 * Everything drizzle-related loads through ONE createRequire so the schema
 * barrel (CJS) and the operators come from the same drizzle-orm instance —
 * the repo's documented dual-package hazard, avoided the same way
 * server/src/db.js avoids it.
 *
 * A private Neon client rather than require("../../db"): that module reads
 * DATABASE_URL at load time, which would make this file's import order a trap.
 */
const require = createRequire(import.meta.url);

const { neon } = require("@neondatabase/serverless");
const { drizzle } = require("drizzle-orm/neon-http");

export const schema = require("../../db/schema");
export const ops = require("drizzle-orm");

const client = neon(config.databaseUrl);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const db: any = drizzle(client, { schema });
