import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getOwnProfile } from "@/lib/profile/own-profile";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsPane } from "./settings-pane";
import { AvatarEditor } from "./avatar-editor";
import { ProfileForm } from "./profile-form";
import { DeletionBanner } from "./deletion-banner";

export const metadata: Metadata = { title: "Profile settings" };

export default async function ProfileSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // Owner bundle — a different query from the public view, so a private field
  // can't leak by accident (Docs/user/profile.md §intro).
  const profile = await getOwnProfile(session.user.id);
  if (!profile) redirect("/login");

  return (
    <SettingsPane title="Profile">
      <DeletionBanner deletionScheduledAt={profile.deletionScheduledAt} />

      <Card>
        <CardHeader>
          <CardTitle>Photo</CardTitle>
          <CardDescription>JPG, PNG or WebP · up to 5MB · at least 200×200.</CardDescription>
        </CardHeader>
        <CardContent>
          <AvatarEditor avatarUrl={profile.avatarUrl} firstName={profile.firstName} lastName={profile.lastName} />
        </CardContent>
      </Card>

      <ProfileForm profile={profile} />
    </SettingsPane>
  );
}
