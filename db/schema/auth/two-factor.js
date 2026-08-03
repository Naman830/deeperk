const { pgTable, text } = require("drizzle-orm/pg-core");
const { user } = require("./user");

// Better Auth `twoFactor` plugin — TOTP secret (encrypted at rest with
// BETTER_AUTH_SECRET) and single-use backup codes (hashed, same rule as
// passwords). auth.md §4, §8.
const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
});

module.exports = { twoFactor };
