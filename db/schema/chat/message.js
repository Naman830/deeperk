// This message.js is basically the chat history table.
// It stores every message sent inside a conversation, including call bubbles.

const { randomUUID } = require("node:crypto");
const { sql } = require("drizzle-orm");
const {
  pgTable,
  text,
  integer,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
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
    // Kept alongside mediaUrl, unlike user.avatarPublicId which stores only the
    // id: a video/raw delivery URL isn't derivable from the public_id alone
    // (it encodes resource_type, and for raw the extension). So the URL renders
    // and the public_id is what destroyAsset and the orphan sweep can act on.
    mediaPublicId: text("media_public_id"),
    mediaMime: text("media_mime"),
    // Intrinsic pixel dimensions, IMAGE/VIDEO only. Populated from the
    // sharp().metadata() call the upload route already makes and used to throw
    // away. They exist so a bubble can reserve the right aspect box before the
    // asset loads — without them every image load reflows the thread and
    // re-triggers use-stick-to-bottom's ResizeObserver.
    mediaWidth: integer("media_width"),
    mediaHeight: integer("media_height"),
    mediaSize: integer("media_size"), // bytes
    mediaName: text("media_name"),

    // Client-generated id for the optimistic bubble, echoed back on broadcast.
    // socket.io buffers emits while disconnected and flushes them on reconnect,
    // so a send can be marked failed, retried, and then have the original
    // arrive too. The unique index below makes that duplicate impossible; an
    // in-memory dedupe can't, because it's lost on the very reconnect that
    // causes the retry.
    clientMsgId: text("client_msg_id"),

    // Quoted message (Phase 2 reply/quote). Self-referencing.
    // SET NULL, not CASCADE: if the quoted message is hard-deleted the reply is
    // still a real thing somebody said, and losing it would punch a hole in the
    // conversation. The UI renders a "message unavailable" stub instead.
    replyToId: text("reply_to_id").references(() => message.id, {
      onDelete: "set null",
    }),

    // CALL
    callId: text("call_id").references(() => call.id, { onDelete: "set null" }),
    // Why callId uses SET NULL ---> If the call record disappears: ---> becomes: message → null

    // timestamps
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // Non-null means the body was changed after sending. The bubble shows an
    // "edited" marker; createdAt is never touched, so ordering is stable.
    editedAt: timestamp("edited_at", { withTimezone: true }),
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

    // Partial because SYSTEM and CALL messages carry no client id. NULLs are
    // distinct in Postgres so a plain unique index would also be correct, but
    // this keeps the index to rows that can actually conflict.
    uniqueIndex("uq_message_sender_client_msg_id")
      .on(table.senderId, table.clientMsgId)
      .where(sql`${table.clientMsgId} IS NOT NULL`),

    // Lets a hard delete of a quoted message find its replies without a scan.
    index("idx_message_reply_to").on(table.replyToId),
  ],
);

module.exports = { messageTypeEnum, message };
