// Shared Drizzle operators for web/.
// Use require() here so TS and CommonJS use the same Drizzle types.
//
// Import operators from here, never from "drizzle-orm" directly: db/schema/*.js
// resolves drizzle-orm via the `require` condition (.d.cts) while web/'s .ts
// files resolve via `import` (.d.ts), and TypeScript treats the two SQL/Column
// classes as unrelated. Add to this list rather than importing around it.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ops = require("drizzle-orm");

const {
  eq,
  ne,
  and,
  or,
  not,
  gt,
  gte,
  lt,
  lte,
  sql,
  isNull,
  isNotNull,
  inArray,
  exists,
  ilike,
  asc,
  desc,
  count,
} = ops;

module.exports = {
  eq,
  ne,
  and,
  or,
  not,
  gt,
  gte,
  lt,
  lte,
  sql,
  isNull,
  isNotNull,
  inArray,
  exists,
  ilike,
  asc,
  desc,
  count,
};
