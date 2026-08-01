const {
  pgTable,
  text,
  boolean,
  timestamp,
  date,
  index,
} = require("drizzle-orm/pg-core");

const user = pgTable(
  "user",
  {
    // ==========================================================
    // 1. Core Identity (Created during signup)
    // ==========================================================

    id: text("id").primaryKey(), // Unique ID for every user
    name: text("name").notNull(), // Full name
    username: text("username").unique().notNull(), // Unique username (used for search)
    displayUsername: text("display_username"), // Username displayed exactly as the user typed
    email: text("email").notNull().unique(), // User email
    emailVerified: boolean("email_verified").notNull().default(false), // Has the email been verified?
    birthDate: date("birth_date").notNull(), // Used to confirm user is at least 13 years old
    createdAt: timestamp("created_at").defaultNow().notNull(), // Account creation time
    updatedAt: timestamp("updated_at").defaultNow().notNull(), // Last profile update time

    // ==========================================================
    // 2. Profile Information
    // ==========================================================

    avatarUrl: text("avatar_url"), // Profile picture
    bio: text("bio"), // About the user
    website: text("website"), // Personal website
    location: text("location"), // User location
    gender: text("gender"), // User-selected gender
    interests: text("interests").array().default([]).notNull(), // List of interests

    // ==========================================================
    // 3. Presence
    // ==========================================================

    isOnline: boolean("is_online").default(false).notNull(), // Is the user currently online?
    lastSeenAt: timestamp("last_seen_at"), // Last active time

    // ==========================================================
    // 4. Security & Verification
    // ==========================================================

    phoneNumber: text("phone_number"), // Optional phone number
    phoneVerified: boolean("phone_verified").default(false).notNull(), // Phone verification status
    twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(), // Has 2FA been enabled?

    // ==========================================================
    // 5. Account Management
    // ==========================================================

    usernameChangedAt: timestamp("username_changed_at"), // Last username change
    deactivatedAt: timestamp("deactivated_at"), // Temporary deactivation
    deletionScheduledAt: timestamp("deletion_scheduled_at"), // Scheduled permanent deletion
  },

  (table) => ({
    deletionScheduledAtIdx: index("user_deletion_scheduled_at_idx").on(
      table.deletionScheduledAt,
    ),
  }),
);

module.exports = { user };
