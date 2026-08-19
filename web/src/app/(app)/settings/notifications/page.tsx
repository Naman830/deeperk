import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { SettingsPane } from "../settings-pane";
import { NotificationsForm } from "./notifications-form";

export const metadata: Metadata = { title: "Notification settings" };

export default async function NotificationSettingsPage() {
  const session = await getSession();
  if (!session) redirect("/login");

  // No profile fetch: unlike every other settings page, nothing here is stored
  // on the server. These are per-device display preferences held in
  // localStorage — see lib/realtime/notification-prefs.ts for the reasoning,
  // and for why per-conversation mute is the one exception that does live in
  // the database.
  return (
    <SettingsPane title="Notifications">
      <p className="text-muted-foreground text-sm">
        These apply to this device only, so you can keep sound on your desktop and silence on a laptop. To silence one
        conversation everywhere, use <span className="text-foreground font-medium">Mute</span> in that chat&rsquo;s menu.
      </p>
      <NotificationsForm />
    </SettingsPane>
  );
}
