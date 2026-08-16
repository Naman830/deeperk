import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getOwnProfile } from "@/lib/profile/own-profile";
import { AppRail } from "./app-rail";
import { RAIL_COOKIE, isRailCollapsed } from "./rail-cookie";

// Every authenticated screen lives under this layout. getSession() also clears a
// pending deletionScheduledAt, so simply reaching the app cancels a deletion.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Read the rail's identity from the DB rather than the session, so an avatar
  // or name change shows up on the next router.refresh() instead of waiting for
  // the session cookie to be reissued.
  const profile = await getOwnProfile(session.user.id);
  if (!profile) redirect("/login");

  // Read server-side so the rail renders at its stored width in the first byte —
  // no flash, no inline script. This layout is already dynamic, so it's free.
  const railCollapsed = isRailCollapsed((await cookies()).get(RAIL_COOKIE)?.value);

  return (
    // pb-16 clears the mobile bottom tab bar; md:pb-0 once the rail goes vertical.
    <div className="flex h-dvh flex-col overflow-hidden pb-16 md:flex-row md:pb-0">
      <AppRail
        defaultCollapsed={railCollapsed}
        username={profile.username}
        displayUsername={profile.displayUsername}
        firstName={profile.firstName}
        lastName={profile.lastName}
        avatarUrl={profile.avatarUrl}
      />
      <div className="flex h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}
