// Drizzle operators shared by TS code and CommonJS schemas.
// Keeps both sides on the same Drizzle type path.
const { eq, and, gt, sql, isNull } = require("drizzle-orm");

module.exports = { eq, and, gt, sql, isNull };
