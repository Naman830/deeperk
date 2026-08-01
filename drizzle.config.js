require("dotenv/config");
const { defineConfig } = require("drizzle-kit");

module.exports = defineConfig({
  schema: "./db/schema.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
