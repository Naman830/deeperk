import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getOwnProfile } from "@/lib/profile/own-profile";
import { listConversations } from "@/lib/chat/conversations";
import { AppRail } from "./app-rail";
import { RealtimeProvider } from "./realtime-provider";
import { RAIL_COOKIE, isRailCollapsed } from "./rail-cookie";

// Every authenticated screen lives under this layout. getSession() also clears a
// pending deletionScheduledAt, so simply reaching the app cancels a deletion.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Read the rail's identity from the DB rather than the session, so an avatar
  // or name change shows up on the next router.refresh() instead of waiting for
  // the session cookie to be reissued.
  // Seeded here rather than in (messaging)/layout.tsx because the rail's unread
  // badge is a sibling of {children}, not a descendant of the messaging layout —
  // fetching lower down would make the badge pop in after hydration and give the
  // badge and the list two sources of truth. Partial rendering means this runs
  // once per full page load, not per navigation.
  const [profile, chat] = await Promise.all([getOwnProfile(session.user.id), listConversations(session.user.id)]);
  if (!profile) redirect("/login");

  // Read server-side so the rail renders at its stored width in the first byte —
  // no flash, no inline script. This layout is already dynamic, so it's free.
  const railCollapsed = isRailCollapsed((await cookies()).get(RAIL_COOKIE)?.value);

  return (
    // The provider wraps the rail as well as {children}, which is the whole
    // reason it lives at this level. {children} stays a server-rendered JSX
    // prop, so (messaging)/layout.tsx remains a server component.
    <RealtimeProvider viewerId={session.user.id} initialConversations={chat.conversations}>
      {/* pb-16 clears the mobile bottom tab bar; md:pb-0 once the rail goes vertical. */}
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
    </RealtimeProvider>
  );
}
