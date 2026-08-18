// One user blocking another.
//
// A new `social/` domain rather than a chat/ table: blocking is a user-to-user
// relation that gates search, profile visibility and group invites as well as
// messaging. This is also where the deferred `follow` table lands when its
// feature doc exists.

const {
  pgTable,
  text,
  timestamp,
  primaryKey,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

/*
user A ── block ──> user B      (A blocked B; not symmetric)
*/
const block = pgTable(
  "block",
  {
    // Both RESTRICT, matching the repo-wide rule for FKs to user. A block is
    // also a safety record — it must not evaporate because of an out-of-band
    // delete of either side.
    blockerId: text("blocker_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    blockedId: text("blocked_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Idempotent blocking, and serves "have I blocked X" (the leading column).
    primaryKey({ columns: [table.blockerId, table.blockedId] }),

    // This one is NOT redundant with the PK. Every gate asks the question in
    // both directions at once — "did either of us block the other" — and the
    // reverse half (blocked_id = me) leads with the PK's *second* column, which
    // a btree cannot serve.
    index("idx_block_blocked").on(table.blockedId),
  ],
);

module.exports = { block };
