const { pgTable, text, timestamp } = require("drizzle-orm/pg-core");
const { user } = require("./user");

// Better Auth — credentials live here, never on `user`, so a stray
// `SELECT user.*` can never leak a password hash (auth.md §4).
const account = pgTable("account", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(), // "credential" for password
  password: text("password"), // scrypt hash + per-user salt — never readable

  // OAuth-provider fields (unused today, part of Better Auth's default shape)
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

module.exports = { account };
