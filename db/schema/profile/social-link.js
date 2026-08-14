// It stores social media links belonging to a user.

const { randomUUID } = require("node:crypto");
const { pgTable, text, timestamp, index } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

/*
  Social links owned by a user.
  Max 4 links is enforced by the app.
*/

const socialLink = pgTable(
  "social_link",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),

    platform: text("platform").notNull(),

    url: text("url").notNull(), // valid http(s) URL, app-validated

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_social_link_user").on(table.userId)],
);

module.exports = { socialLink };
