// This table is basically the link between a call and the users inside that call.
// It supports both 1-to-1 and group calls

const {
  pgTable,
  text,
  timestamp,
  primaryKey,
  index,
} = require("drizzle-orm/pg-core");
const { user } = require("../auth/user");
const { call } = require("./call");

/*
 Users in a call.
 joinedAt is null until they join.
*/

const callParticipant = pgTable(
  "call_participant", // stores who joined that call and when they joined/left.
  {
    // No separate id is needed because (callId, userId) already uniquely identifies the row.
    callId: text("call_id")
      .notNull()
      .references(() => call.id, { onDelete: "cascade" }),

    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),

    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    // One row per user per call.
    primaryKey({ columns: [table.callId, table.userId] }),

    // Fast "is this user in a call?" lookup.
    index("idx_call_participant_user").on(table.userId),
  ],
);

module.exports = { callParticipant };
