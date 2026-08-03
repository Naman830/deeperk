// Better Auth tables + the two we own (pendingRegistrations, authEvents).
// See Docs/user/auth.md §4 for what belongs to Better Auth vs. us.

module.exports = {
  ...require("./user"),
  ...require("./session"),
  ...require("./account"),
  ...require("./verification"),
  ...require("./two-factor"),
  ...require("./pending-registration"),
  ...require("./auth-event"),
};
