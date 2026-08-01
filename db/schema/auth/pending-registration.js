const {
  pgTable,
  text,
  integer,
  timestamp,
  index,
} = require("drizzle-orm/pg-core");

// ==========================================================
// Pending Registration Table
// ==========================================================
// Stores users who have started the signup process but
// have NOT verified their email yet.
//
// Why do we need this?
// Better Auth verifies OTPs for existing users only.
// During signup, no user record exists yet, so we keep
// the registration information here until the email is
// successfully verified.
//
// Flow:
// User enters details
//        ↓
// Store email + hashed OTP here
//        ↓
// User enters OTP
//        ↓
// OTP verified?
//        ↓
// Create a row in the `user` table
//        ↓
// Delete this pending registration
//
// These records expire after 15 minutes and are
// periodically cleaned up.
// ==========================================================

const pendingRegistrations = pgTable(
  "pending_registration",
  {
    // --------------------------------------------------------
    // Registration Information
    // --------------------------------------------------------

    id: text("id").primaryKey(), // Unique ID for this pending registration
    email: text("email").notNull().unique(), // Email waiting for verification
    otpHash: text("otp_hash").notNull(), // SHA-256 hash of the OTP (never store the actual OTP)

    // --------------------------------------------------------
    // Verification State
    // --------------------------------------------------------

    attempts: integer("attempts").default(0).notNull(), // Number of OTP verification attempts
    verifiedAt: timestamp("verified_at"), // Set after successful OTP verification
    expiresAt: timestamp("expires_at").notNull(), // Registration expires after 15 minutes

    // --------------------------------------------------------
    // Audit Fields
    // --------------------------------------------------------

    createdAt: timestamp("created_at").defaultNow().notNull(), // When the registration was created
  },

  (table) => ({
    // Index used by cleanup jobs to quickly find expired registrations
    expiresAtIdx: index("pending_reg_expires_at_idx").on(table.expiresAt),
  }),
);

module.exports = { pendingRegistrations };
