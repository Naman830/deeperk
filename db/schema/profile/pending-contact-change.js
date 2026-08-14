// It is not the actual email. It is only a temporary verification record.

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// Contact types that can be changed.
const pendingContactChangeTypeEnum = pgEnum(
  "pending_contact_change_type_enum",
  ["EMAIL"],
);

/*
  Temporary record for email change verification.
  Deleted after success, failure, or expiry.
*/

const pendingContactChange = pgTable(
  "pending_contact_change",
  {
    // unique ID for the pending request.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // who is trying to change their email.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    type: pendingContactChangeTypeEnum("type").notNull(),

    newValue: text("new_value").notNull(),

    otpHash: text("otp_hash").notNull(),

    attempts: integer("attempts").notNull().default(0),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(), // 5-min TTL

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_pending_contact_change_user").on(table.userId)],
);

module.exports = { pendingContactChangeTypeEnum, pendingContactChange };
