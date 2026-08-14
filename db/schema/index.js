/**
 * Root schema.
 *
 * Re-exports every domain schema so Drizzle can see all tables and enums.
 *
 * Keep exports unique. Duplicate names can overwrite each other.
 *
 * Enum = "This field has a small, known list of choices.
 */

module.exports = {
  ...require("./auth"),
  ...require("./profile"),
  ...require("./chat"),
  ...require("./call"),
};

/*
db/
└── schema/
    ├── index.js          ← all domains
    │
    ├── auth/
    │   └── index.js      ← user, account, session, etc.
    │
    ├── profile/
    │   └── index.js      ← profile tables
    │
    ├── chat/
    │   └── index.js      ← conversation, message, etc.
    │
    └── call/
        └── index.js      ← call tables
*/
