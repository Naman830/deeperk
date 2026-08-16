// Re-export the shared root DB connection for web/.
// Do not create a separate connection here.
export { db } from "../../../../db";