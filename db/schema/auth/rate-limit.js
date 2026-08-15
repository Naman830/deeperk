// This rateLimitHit table is basically a small database counter for rate limits.

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} = require("drizzle-orm/pg-core");

// Stores the counter for one rate-limit bucket.
const rateLimitHit = pgTable(
  "rate_limit_hit",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    bucketKey: text("bucket_key").notNull(),

    // Start of the current limit window.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),

    // Number of hits in this window.
    count: integer("count").notNull().default(1),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("uq_rate_limit_hit_bucket_key").on(table.bucketKey)],
);

module.exports = { rateLimitHit };
