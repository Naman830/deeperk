const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  boolean,
  date,
  timestamp,
  uniqueIndex,
} = require("drizzle-orm/pg-core");

/*
Main user table.
Other domains reference this table.
Users are anonymized instead of deleted.
*/

const user = pgTable(
  "user",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // Identity (Docs/user/auth.md)
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),

    firstName: text("first_name").notNull(),
    lastName: text("last_name"),

    username: text("username").notNull(),
    displayUsername: text("display_username").notNull(),

    birthDate: date("birth_date").notNull(),

    // Profile (Docs/user/profile.md)

    bio: text("bio"),
    avatarPublicId: text("avatar_public_id"),

    // Account State (Docs/user/profile.md)
    usernameChangedAt: timestamp("username_changed_at", { withTimezone: true }),

    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),

    deletionScheduledAt: timestamp("deletion_scheduled_at", {
      withTimezone: true,
    }),

    // Presence (Docs/chat/chat.md read/written by the realtime server)
    isOnline: boolean("is_online").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),

    // MetaData
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_user_email").on(table.email),
    uniqueIndex("uq_user_username").on(table.username),
  ],
);

module.exports = { user };
