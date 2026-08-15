import { headers } from "next/headers";
import { auth } from "./auth";

/** Server-side session read for server components / route handlers. */
export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}
