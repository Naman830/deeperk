const { pgTable, text, timestamp, index } = require("drizzle-orm/pg-core");

// Ours — audit log of event types only, never credentials (no emails
// typed, no codes, no passwords). No FK on userId: a failed login attempt
// against an unknown email must still be logged (auth.md §4, §6).
const authEvents = pgTable(
  "auth_event",
  {
    id: text("id").primaryKey(),
    userId: text("user_id"), // null for failed attempts on unknown emails
    type: text("type").notNull(), // login_ok | login_fail | otp_sent | password_changed | 2fa_enabled | ...
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userCreatedIdx: index("auth_event_user_created_idx").on(table.userId, table.createdAt),
  })
);

module.exports = { authEvents };
