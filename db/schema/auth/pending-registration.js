// This pending_registration table is basically a temporary storage box for signup OTP verification.

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  integer,
  timestamp,
  uniqueIndex,
} = require("drizzle-orm/pg-core");

/*
 Temporary signup OTP row.
 Deleted after verification, 3 failed attempts, or expiry.
*/

const pendingRegistration = pgTable(
  "pending_registration",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    email: text("email").notNull(),

    otpHash: text("otp_hash").notNull(), // sha-256 OTP

    attempts: integer("attempts").notNull().default(0),

    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("uq_pending_registration_email").on(table.email)],
);

module.exports = { pendingRegistration };
