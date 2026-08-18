// "Delete for me" — one row per (message, user) that has hidden it.
// Delete-for-everyone lives on message.deletedAt instead; that one is a
// tombstone the whole room sees, this one is invisible to everybody else.

const {
  pgTable,
  text,
  timestamp,
  primaryKey,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { message } = require("./message");

/*
message
   │
   ├── message_deletion ── user A   (hidden for A only)
   └── message_deletion ── user B   (hidden for B only)
*/
const messageDeletion = pgTable(
  "message_deletion",
  {
    // CASCADE, unlike every other FK in this folder: a "hidden for me" row has
    // no meaning once the message itself is gone. Nothing historical is lost —
    // the row records an absence, not an event.
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),

    // RESTRICT, matching the repo-wide rule for FKs to user.
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    deletedAt: timestamp("deleted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The PK is what makes hiding idempotent: a double-tap, or a retry after a
    // dropped ack, inserts nothing the second time.
    primaryKey({ columns: [table.messageId, table.userId] }),

    // No secondary index, deliberately. The only query is the anti-join
    // "of this page of messages, which are hidden for me" — i.e.
    // (message_id = <row>, user_id = <me>), which the PK serves exactly.
    // Contrast conversation_member, which does need idx_conversation_member_user
    // because "list my chats" has no conversation id to lead with.
  ],
);

module.exports = { messageDeletion };
