// This table is the bridge between users and conversations.
// Which users belong to this conversation, and what is their role/read state?

const {
  pgTable,
  text,
  timestamp,
  pgEnum,
  primaryKey,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("./conversation");

const conversationRoleEnum = pgEnum("conversation_role_enum", [
  "OWNER",
  "ADMIN",
  "MEMBER",
]);

/**
conversation
   │
   ├── conversation_member ── user A (OWNER)
   ├── conversation_member ── user B (MEMBER)
   └── conversation_member ── user C (MEMBER)
*/
const conversationMember = pgTable(
  "conversation_member",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    role: conversationRoleEnum("role").notNull().default("MEMBER"),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    lastReadAt: timestamp("last_read_at", { withTimezone: true }), // You don't create a read-receipt row for every message.
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }), // The same user cannot be added twice to the same conversation.

    index("idx_conversation_member_user").on(table.userId),
    // The primary key starts with: (conversationId, userId)
  ],
);

module.exports = { conversationRoleEnum, conversationMember };
