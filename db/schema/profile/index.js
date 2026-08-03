// Profile & settings tables — see Docs/user/profile.md §10.
// Extends the `user` table owned by ./auth; doesn't redefine it.

module.exports = {
  ...require("./privacy-settings"),
  ...require("./social-link"),
  ...require("./pending-contact-change"),
};
