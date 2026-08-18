// A conversation is one chat container.
// It can be either DIRECT or GROUP. Both use the same table.

const { randomUUID } = require("node:crypto");
const { sql } = require("drizzle-orm");
const {
  pgTable,
  text,
  timestamp,
  pgEnum,
  index,
  uniqueIndex,
  check,
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

    // Cloudinary public_id, not a URL — the URL is derived at render time so
    // f_auto/q_auto and a size can be applied, and so a delete has a handle.
    // Same shape as user.avatarPublicId. Groups only.
    avatarPublicId: text("avatar_public_id"),

    // DIRECT only: both member ids sorted and joined with ":". neon-http has no
    // interactive transactions, so a read-then-insert can race two simultaneous
    // "Message" clicks into two DMs. The unique index below makes creation an
    // idempotent upsert instead. NULL for groups — Postgres treats NULLs as
    // distinct, so every group row coexists under the same index.
    directKey: text("direct_key"),

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
  (table) => [
    index("idx_conversation_updated_at").on(table.updatedAt),

    uniqueIndex("uq_conversation_direct_key").on(table.directKey),

    // Makes "DIRECT rows always have a key, groups never do" a database
    // guarantee rather than a convention the app has to remember.
    check(
      "ck_conversation_direct_key",
      sql`(${table.type} = 'DIRECT') = (${table.directKey} IS NOT NULL)`,
    ),
  ],
);

module.exports = { conversationTypeEnum, conversation };
