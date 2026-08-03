const { pgTable, text, timestamp } = require("drizzle-orm/pg-core");
const { user } = require("./user");

// Better Auth — one row per active login. Deleting a row logs that device
// out instantly; this is why we use sessions instead of JWTs (auth.md §7).
const session = pgTable("session", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { session };
