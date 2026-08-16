import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { getOwnProfile } from "@/lib/profile/own-profile";
import { SettingsPane } from "../settings-pane";
import { PrivacyForm } from "./privacy-form";

export const metadata: Metadata = { title: "Privacy settings" };

export default async function PrivacySettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  const profile = await getOwnProfile(session.user.id);
  if (!profile) redirect("/login");

  return (
    <SettingsPane title="Privacy">
      <p className="text-muted-foreground text-sm">
        These are enforced on the server, so turning something off actually removes it from the responses other people receive.
      </p>
      <PrivacyForm initial={profile.privacy} />
    </SettingsPane>
  );
}
