// A conversation is one chat container.
// It can be either DIRECT or GROUP. Both use the same table.

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");

// This creates an enum with only 2 allowed values:
// DIRECT → 1-to-1 chat / GROUP → group chat
const conversationTypeEnum = pgEnum("conversation_type_enum", [
  "DIRECT",
  "GROUP",
]);

/*
One chat container for both DMs and groups.

user
  │
  ├── creates ──> conversation
  │
  └── joins ────> conversation_member ───> conversation
                                             │
                                             ├── messages
                                             └── calls
*/
const conversation = pgTable(
  "conversation",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    type: conversationTypeEnum("type").notNull(),
    name: text("name"), // groups only, 1-50 chars, app-validated
    avatarUrl: text("avatar_url"), // groups only

    createdById: text("created_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    // Why createdById uses RESTRICT
    // This means: Don't allow the user row to be deleted if historical conversations still point to it.

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Updated when a new message is sent.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("idx_conversation_updated_at").on(table.updatedAt)],
);

module.exports = { conversationTypeEnum, conversation };
