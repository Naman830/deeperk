// Who is currently logged in, and until when?

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("./user");

/*
 Stores active Better Auth login sessions.
 One user can have multiple sessions.
*/

const session = pgTable(
  "session",
  {
    // Unique session ID.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // Token stored in the httpOnly cookie.
    token: text("token").notNull(),

    // User who owns this session.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // When the session expires.
    ipAddress: text("ip_address"), // Login IP address.
    userAgent: text("user_agent"), // Browser/device information.

    // Session timestamps.
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Token must be unique and fast to find.
    uniqueIndex("uq_session_token").on(table.token),
    index("idx_session_user").on(table.userId),
  ],
);

module.exports = { session };
