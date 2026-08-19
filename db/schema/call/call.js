// This call.js is the main table for storing call history/state

const { randomUUID } = require("node:crypto");
const {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { conversation } = require("../chat/conversation");

// Call media type.
const callKindEnum = pgEnum("call_kind_enum", ["AUDIO", "VIDEO"]);

// Call lifecycle state.
const callStatusEnum = pgEnum("call_status_enum", [
  "RINGING",
  "ONGOING",
  "ENDED",
  "MISSED",
  "REJECTED",
]);

// One row per call attempt.
const call = pgTable(
  "call",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),

    // Which chat/group this call belongs to.
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id, { onDelete: "cascade" }),

    // User who started the call.
    startedById: text("started_by_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    kind: callKindEnum("kind").notNull(), // Tell Which type

    status: callStatusEnum("status").notNull().default("RINGING"), // Where the call currently is:

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    index("idx_call_conversation_started_at").on(
      table.conversationId,
      table.startedAt,
    ),
    // Cross-conversation history feed: the (started_at, id) keyset in
    // web/src/lib/call/history.ts — the index above leads with conversation_id
    // and cannot serve it.
    index("idx_call_started_at_id").on(table.startedAt, table.id),
  ],
);

module.exports = { callKindEnum, callStatusEnum, call };
