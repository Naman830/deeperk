// Holds an old username for 30 days after it changes.
const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("./user");

// When someone changes naman → naman123, the old naman is kept unavailable for 30 days, so another user cannot immediately take it.

const reservedUsername = pgTable(
  "reserved_username",
  {
    // Unique reservation ID.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // Old username being held.
    username: text("username").notNull(),

    // Previous owner.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // When the 30-day hold ends.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // 30-day hold

    // When the hold was created.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One reservation per username.
    uniqueIndex("uq_reserved_username_username").on(table.username),
    // Find reservations owned by a user.
    index("idx_reserved_username_user").on(table.userId),
  ],
);

module.exports = { reservedUsername };
