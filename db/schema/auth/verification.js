const { pgTable, text, timestamp } = require("drizzle-orm/pg-core");

// ==========================================================
// Verification Table
// ==========================================================
// Stores temporary verification records used by Better Auth.
//
// Purpose:
// - Password reset tokens
// - Sign-in OTPs
//
// Important:
// This table is NOT for new user registration.
// Signup verification is handled by our own
// `pendingRegistrations` table because the user
// account does not exist until email verification
// is completed.
// ==========================================================

const verification = pgTable("verification", {
  // --------------------------------------------------------
  // Core Verification Data
  // --------------------------------------------------------

  id: text("id").primaryKey(), // Unique ID for this verification record
  identifier: text("identifier").notNull(), // Identifies the user (usually email or user ID)
  value: text("value").notNull(), // Hashed OTP / reset token (never store plain OTP)
  expiresAt: timestamp("expires_at").notNull(), // When this verification becomes invalid

  // --------------------------------------------------------
  // Audit Fields
  // --------------------------------------------------------

  createdAt: timestamp("created_at").defaultNow().notNull(), // Record creation time
  updatedAt: timestamp("updated_at").defaultNow().notNull(), // Last update time
});

module.exports = { verification };
