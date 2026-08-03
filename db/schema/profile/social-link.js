const { pgTable, text, unique } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// Up to 5 links per user, typed rows rather than a JSON blob —
// same reasoning as auth.md §2's "typed, not JSON soup" (profile.md §10).
const socialLinks = pgTable(
  "social_link",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(), // "github" | "x" | "instagram" | ...
    url: text("url").notNull(),
  },
  (table) => ({
    userPlatformUnique: unique("social_link_user_platform_unique").on(table.userId, table.platform), // one link per platform
  })
);

module.exports = { socialLinks };
