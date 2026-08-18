// This table is the bridge between users and conversations.
// Which users belong to this conversation, and what is their role/read state?

const { sql } = require("drizzle-orm");
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

    // The middle tick. Genuinely distinct from lastReadAt and not derivable
    // from it: a message can reach a device that nobody has looked at. Stamped
    // when a member's socket receives (or backfills) a message, GREATEST-clamped
    // server-side exactly like lastReadAt so it can only move forwards.
    //
    // Read receipts are two watermarks, never a per-message receipt table: a
    // message is "read by X" iff X.lastReadAt >= message.createdAt. A receipt
    // table would write O(members x messages) rows to encode what these two
    // columns already do.
    lastDeliveredAt: timestamp("last_delivered_at", { withTimezone: true }),

    // --- per-member conversation state -------------------------------------
    // All five are per-member, which is why they live here and not on
    // conversation: pinning, muting, archiving, clearing and hiding are one
    // person's view of a shared thread and must never be visible to the others.

    // Non-null = pinned. A timestamp rather than a boolean because the value
    // doubles as the pin ordering, for free.
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),

    // A timestamp, not a boolean: "mute for 8 hours" is the common case and a
    // boolean cannot express it. NULL = not muted, a far-future date = always.
    mutedUntil: timestamp("muted_until", { withTimezone: true }),

    // Cleared automatically when a new message arrives, WhatsApp-style.
    archivedAt: timestamp("archived_at", { withTimezone: true }),

    // "Clear chat" watermark — history is filtered to createdAt > cleared_at.
    // A watermark, NOT bulk message_deletion inserts: clearing a 10k-message
    // chat would otherwise be 10k rows on a driver with no transactions, and a
    // partial failure would leave it half-cleared with no way to detect or
    // resume. One timestamp is atomic and instant, and composes with
    // message_deletion (both predicates apply).
    clearedAt: timestamp("cleared_at", { withTimezone: true }),

    // "Delete chat" — drops the conversation from YOUR sidebar only. Paired
    // with clearedAt, never set alone. Un-hiding is implicit: the sidebar query
    // only hides a row while its newest message is at or before this instant,
    // so a new message brings the conversation back with just that message
    // visible. No un-delete endpoint, no resurrection job.
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.userId] }), // The same user cannot be added twice to the same conversation.

    index("idx_conversation_member_user").on(table.userId),
    // The primary key starts with: (conversationId, userId)

    // Partial, so it indexes only the handful of rows that are actually pinned
    // rather than every membership in the system. Serves the sidebar's
    // pinned-first sort without widening the hot index above.
    index("idx_conversation_member_pinned")
      .on(table.userId, table.pinnedAt)
      .where(sql`${table.pinnedAt} is not null`),
  ],
);

module.exports = { conversationRoleEnum, conversationMember };
