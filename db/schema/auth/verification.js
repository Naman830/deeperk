// Store temporary codes/tokens used to verify an identifier, mainly email.

const { randomUUID } = require("node:crypto");
const { pgTable, text, timestamp, index } = require("drizzle-orm/pg-core");

const verification = pgTable(
  "verification",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    identifier: text("identifier").notNull(), // e.g. email
    value: text("value").notNull(), // the code/token

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_verification_identifier").on(table.identifier)],
);

module.exports = { verification };
