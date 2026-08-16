// Shared Drizzle operators for web/.
// Use require() here so TS and CommonJS use the same Drizzle types.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { eq, ne, and, or, gt, sql, isNull, ilike, asc } = require("drizzle-orm");

module.exports = { eq, ne, and, or, gt, sql, isNull, ilike, asc };
