// it's a 1:1 relationship. privacy setting that can adjust by user

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// One privacy settings row per user.
const privacySettings = pgTable(
  "privacy_settings",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // User who owns these settings.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    // Who can find this user.
    discoverable: text("discoverable").notNull().default("EVERYONE"),

    // Who can see online/last-seen status.
    onlineStatus: text("online_status").notNull().default("EVERYONE"),

    // Who can see extended profile details.
    profileDetails: text("profile_details").notNull().default("EVERYONE"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("uq_privacy_settings_user").on(table.userId)],
);

module.exports = { privacySettings };
