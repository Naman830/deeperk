const { pgTable, text, integer, timestamp, index, unique, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// Mirrors `pendingRegistrations` from auth.md §4: a JWT can't be
// invalidated after 3 wrong guesses, a row can. Swept by the same
// nightly job (profile.md §10).
const contactTypeEnum = pgEnum("contact_type", ["EMAIL", "PHONE"]);

const pendingContactChanges = pgTable(
  "pending_contact_change",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: contactTypeEnum("type").notNull(),
    newValue: text("new_value").notNull(), // the new email or phone
    otpHash: text("otp_hash").notNull(), // SHA-256. NEVER the code.
    attempts: integer("attempts").default(0).notNull(),
    expiresAt: timestamp("expires_at").notNull(), // now + 5 min
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    userTypeUnique: unique("pending_contact_change_user_type_unique").on(table.userId, table.type), // one pending change at a time
    expiresAtIdx: index("pending_contact_change_expires_at_idx").on(table.expiresAt),
  })
);

module.exports = { contactTypeEnum, pendingContactChanges };
