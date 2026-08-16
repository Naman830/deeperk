import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getPublicProfile } from "@/lib/profile/public-profile";

// Public profile view. Requires a session, per Docs/user/search.md's "any
// authenticated user can view any public profile" model — no anonymous access.
// The gating query itself lives in lib/profile/public-profile.ts so the
// /u/[username] page renders from exactly the same rules.
export async function GET(_request: Request, { params }: { params: Promise<{ username: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const { username } = await params;
  const profile = await getPublicProfile(username, session.user.id);
  if (!profile) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // isOwner is a render hint for the page, not part of the public contract.
  const { isOwner, ...body } = profile;
  void isOwner;
  return NextResponse.json(body);
}
