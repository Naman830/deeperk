const { user } = require("./user");
const { account } = require("./account");
const { session } = require("./session");
const { verification } = require("./verification");
const { pendingRegistration } = require("./pending-registration");
const { rateLimitHit } = require("./rate-limit");

module.exports = {
  user,
  account,
  session,
  verification,
  pendingRegistration,
  rateLimitHit,
};
