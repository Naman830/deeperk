// All tables, auth + app, in one shared schema — see Docs/user/auth.md §14.2.
// One file, one `db` object, one set of JOINs across auth and app data.
// Grouped by domain into subfolders (e.g. ./auth) as the schema grows.

module.exports = {
  ...require("./auth"),
  ...require("./profile"),
};
