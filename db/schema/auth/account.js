// How can this person log in?
const { randomUUID } = require("node:crypto");
const { pgTable, text, timestamp, index } = require("drizzle-orm/pg-core");
const { user } = require("./user");

// Login credentials for a user.

const account = pgTable(
  "account",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }), // onDelete: "cascade" means if the user is permanently removed, the account row is automatically removed too

    providerId: text("provider_id").notNull(),
    // providerId simply tells Better Auth which login method this account uses.
    // "credential" means: This user logs in using email + password.

    password: text("password"), // Hashed Password.

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_account_user").on(table.userId)],
);

module.exports = { account };
