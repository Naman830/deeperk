// The socket server shares the repo-root Drizzle connection rather than making
// its own. Everything here is CommonJS end to end, so it can require the schema
// directly — web/src/lib/db/drizzle-ops.js exists only to dodge the dual-package
// hazard inside web/'s TypeScript, and none of that applies on this side.

const { db } = require("../../../db");
const schema = require("../../../db/schema");
const ops = require("drizzle-orm");

module.exports = { db, schema, ops };
