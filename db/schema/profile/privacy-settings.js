const { pgTable, text, pgEnum } = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// Who can see/reach what. Enforced in the API, never in the UI —
// hiding a button is decoration (profile.md §6).
const audienceEnum = pgEnum("audience", ["EVERYONE", "FRIENDS_OF_FRIENDS", "FRIENDS", "NOBODY"]);

const privacySettings = pgTable("privacy_settings", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),

  discoverable: audienceEnum("discoverable").default("EVERYONE").notNull(), // who can find me in search
  friendRequests: audienceEnum("friend_requests").default("EVERYONE").notNull(), // who can request
  onlineStatus: audienceEnum("online_status").default("EVERYONE").notNull(), // last seen + green dot
  profileDetails: audienceEnum("profile_details").default("EVERYONE").notNull(), // bio, website, location, ...
});

module.exports = { audienceEnum, privacySettings };
