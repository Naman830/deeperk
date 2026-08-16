import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getOwnProfile } from "@/lib/profile/own-profile";
import { SettingsPane } from "../settings-pane";
import { UsernameCard } from "./username-card";
import { EmailCard } from "./email-card";
import { PasswordCard } from "./password-card";
import { DeleteCard } from "./delete-card";

export const metadata: Metadata = { title: "Account settings" };

export default async function AccountSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const profile = await getOwnProfile(session.user.id);
  if (!profile) redirect("/login");

  return (
    <SettingsPane title="Account">
      <UsernameCard displayUsername={profile.displayUsername} usernameChangedAt={profile.usernameChangedAt} />
      {/* Email isn't in the owner bundle — it lives on the session, which is the
          only place it's needed and never leaves the owner's own screen. */}
      <EmailCard email={session.user.email} />
      <PasswordCard />
      <DeleteCard username={profile.username} deletionScheduledAt={profile.deletionScheduledAt} />
    </SettingsPane>
  );
}
