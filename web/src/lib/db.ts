// Re-exports the repo-root db/ singleton (CommonJS) so every part of `web/`
// talks to the SAME Drizzle connection + schema that `server/` will eventually
// use. See Docs/database/db-connection.md — web/ is meant to consume db/ via a
// relative import, not stand up a second connection/schema copy.
//
// This works because web/tsconfig.json has allowJs + esModuleInterop enabled,
// so TS can import db/index.js's `module.exports = { db }` directly.
export { db } from "../../../db";
