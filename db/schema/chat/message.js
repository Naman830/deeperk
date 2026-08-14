// This message.js is basically the chat history table.
// It stores every message sent inside a conversation, including call bubbles.

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("./conversation");
const { call } = require("../call/call");

// Message content type.
const messageTypeEnum = pgEnum("message_type_enum", [
  "TEXT",
  "IMAGE",
  "VIDEO",
  "FILE",
  "SYSTEM",
  "CALL",
]);

/*
user
  │
  └── senderId ──> message <── conversationId ── conversation

message
  │
  └── callId ──> call
*/
const message = pgTable(
  "message",
  {
    // identity
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // ownership
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),

    senderId: text("sender_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    // content
    type: messageTypeEnum("type").notNull().default("TEXT"),
    body: text("body"), // TEXT type (1-4000 chars, app-validated)

    // media IMAGE / VIDEO / FILE
    mediaUrl: text("media_url"),
    mediaMime: text("media_mime"),
    mediaSize: integer("media_size"), // bytes
    mediaName: text("media_name"),

    // CALL
    callId: text("call_id").references(() => call.id, { onDelete: "set null" }),
    // Why callId uses SET NULL ---> If the call record disappears: ---> becomes: message → null

    // timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
  },
  (table) => [
    // Required for cursor-paginated history (30/page, ordered by createdAt, id).
    index("idx_message_conversation_created_at").on(
      table.conversationId,
      table.createdAt,
    ),

    // Not doc-mandated, cheap to add: fast "find the message for this call".
    index("idx_message_call").on(table.callId),
  ],
);

module.exports = { messageTypeEnum, message };
