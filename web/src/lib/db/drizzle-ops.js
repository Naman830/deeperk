// Shared Drizzle operators for web/.
// Use require() here so TS and CommonJS use the same Drizzle types.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { eq, and, gt, sql, isNull } = require("drizzle-orm");

module.exports = { eq, and, gt, sql, isNull };
