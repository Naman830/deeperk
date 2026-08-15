// Re-exports the drizzle-orm query operators we use (eq, sql, ...) via a
// plain CommonJS `require()`, same as db/schema/**/*.js and db/index.js.
//
// Why this file exists: db/schema/*.js is CommonJS, so TypeScript resolves
// its drizzle-orm types through the package's `require` export condition
// (index.d.cts). A `.ts` file doing `import { eq } from "drizzle-orm"`
// instead resolves through the `import` condition (index.d.ts) — a separate
// declaration file. Both describe the same runtime code, but TypeScript
// treats their SQL/Column classes as nominally distinct (private-field
// branding), so `eq(user.email, ...)` fails to type-check against a column
// from db/schema with "Two different types with this name exist".
//
// A tsconfig `paths` remap "fixes" the type error but ALSO redirects Next.js's
// bundler (Turbopack) to the same path for the real runtime import — and
// index.d.cts is a types-only file with no executable code, so the app fails
// to build ("Unknown module type"). Keeping this one bridge file as plain
// CommonJS (loaded via allowJs, not remapped) fixes the type mismatch
// without touching how anything actually resolves at runtime.
const { eq, and, gt, sql } = require("drizzle-orm");

module.exports = { eq, and, gt, sql };
