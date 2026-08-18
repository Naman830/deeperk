// Read and validate configuration once, before anything else is required.
//
// Load order matters here in a way that is easy to get wrong: db/index.js calls
// neon(process.env.DATABASE_URL) at MODULE level, so if the environment isn't
// populated before the first require("../../db") you get neon(undefined) and
// every query fails with an opaque error. The npm scripts use
// `node --env-file=.env`, which populates the environment before any module
// loads at all — that is why there is no dotenv call in this codebase.

function list(value, fallback) {
  return (value ?? fallback)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const webOrigins = list(process.env.WEB_ORIGIN, "http://localhost:3000");

const env = {
  // chat.md §3 names SOCKET_PORT. PORT is honoured as a fallback because most
  // hosts inject it.
  SOCKET_PORT: Number(process.env.SOCKET_PORT || process.env.PORT || 4000),

  // Browser-facing origins, for both the CORS config and the allowRequest
  // origin check. Never "*", never a reflected header.
  WEB_ORIGINS: webOrigins,

  // Where to reach Next for the session handshake. Separate from WEB_ORIGINS
  // because in production the socket process may reach Next over a private
  // address while the public origin differs.
  WEB_INTERNAL_URL: process.env.WEB_INTERNAL_URL || webOrigins[0] || "http://localhost:3000",

  INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET || "",
  MEDIA_SIGNING_SECRET: process.env.MEDIA_SIGNING_SECRET || "",

  // The boot-time "everyone is offline" reset is only correct when exactly one
  // socket process exists. With two, the second one's boot marks the first
  // one's users offline. Set to "false" before ever running a second instance
  // (at which point presence needs the Redis adapter anyway).
  SINGLE_INSTANCE: process.env.SOCKET_SINGLE_INSTANCE !== "false",
};

if (!process.env.DATABASE_URL) {
  console.error("[socket] DATABASE_URL is not set — refusing to start.");
  console.error("[socket] Without it, broadcasts would still fire while nothing persisted.");
  process.exit(1);
}

if (Number.isNaN(env.SOCKET_PORT)) {
  console.error("[socket] SOCKET_PORT is not a number.");
  process.exit(1);
}

module.exports = { env };
