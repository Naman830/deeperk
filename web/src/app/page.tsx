import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

// The app has no marketing page — "/" is just a doorway.
export default async function Home() {
  const session = await getSession();
  redirect(session ? "/chats" : "/login");
}
