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

    // Login method. "credential" = email + password.
    providerId: text("provider_id").notNull(),

    // Required by Better Auth.
    accountId: text("account_id").notNull(),

    // Better Auth fields; unused because we only use credentials.
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),

    // Hashed password.
    password: text("password"),

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
