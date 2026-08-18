import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Link2, Pencil } from "lucide-react";
import { getSession } from "@/lib/auth/session";
import { getPublicProfile } from "@/lib/profile/public-profile";
import { MainPane } from "@/components/features/shell/main-pane";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { MessageButton } from "@/components/features/messaging/message-button";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

export async function generateMetadata({ params }: { params: Promise<{ username: string }> }): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
}

function lastSeenLabel(lastSeenAt: Date | null | undefined) {
  if (!lastSeenAt) return "Offline";
  return `Last seen ${new Date(lastSeenAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
}

export default async function PublicProfilePage({ params }: { params: Promise<{ username: string }> }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { username } = await params;
  // Same gated query the API uses. Deactivated and deletion-scheduled accounts
  // return null, so all three cases render one identical 404.
  const profile = await getPublicProfile(username, session.user.id);
  if (!profile) notFound();

  const fullName = `${profile.firstName} ${profile.lastName ?? ""}`.trim();
  // Gated fields are absent from the object rather than null — branch on the key.
  const showsPresence = "isOnline" in profile;
  const showsDetails = "bio" in profile;

  return (
    <MainPane>
      <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 md:px-5">
        <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
          <Link href="/chats" aria-label="Back to chats">
            <ArrowLeft />
          </Link>
        </Button>
        <span className="truncate text-sm font-medium">@{profile.displayUsername}</span>
      </header>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-lg flex-col items-center gap-4 px-6 py-10">
          <UserAvatar
            src={profile.avatarUrl}
            firstName={profile.firstName}
            lastName={profile.lastName}
            size="xl"
            isOnline={showsPresence ? profile.isOnline : undefined}
          />

          <div className="text-center">
            <h1 className="font-heading text-2xl font-semibold tracking-tight">{fullName}</h1>
            <p className="text-muted-foreground text-sm">@{profile.displayUsername}</p>
            {showsPresence && (
              <p className="text-muted-foreground mt-1 text-xs">{profile.isOnline ? "Online now" : lastSeenLabel(profile.lastSeenAt)}</p>
            )}
          </div>

          {profile.isOwner ? (
            <Button asChild variant="outline" size="lg">
              <Link href="/settings/profile">
                <Pencil /> Edit profile
              </Link>
            </Button>
          ) : (
            <MessageButton username={profile.username} />
          )}

          {showsDetails && (
            <>
              {profile.bio && (
                <>
                  <Separator className="my-2" />
                  {/* Plain JSX — React escapes it. Never dangerouslySetInnerHTML:
                      per Docs/user/profile.md §1 this is the entire XSS defence. */}
                  <p className="text-center text-sm leading-relaxed whitespace-pre-wrap">{profile.bio}</p>
                </>
              )}

              {profile.socialLinks && profile.socialLinks.length > 0 && (
                <>
                  <Separator className="my-2" />
                  <ul className="flex w-full flex-col gap-1.5">
                    {profile.socialLinks.map((link) => (
                      <li key={link.id}>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          className="hover:bg-accent flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors"
                        >
                          <Link2 size={15} className="text-muted-foreground shrink-0" />
                          <span className="font-medium">{link.platform}</span>
                          <span className="text-muted-foreground ml-auto truncate text-xs">{link.url}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}

          {!showsDetails && <p className="text-muted-foreground text-sm">This user keeps their profile details private.</p>}
        </div>
      </div>
    </MainPane>
  );
}
