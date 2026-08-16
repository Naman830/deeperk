import type { Metadata } from "next";
import { SlidersHorizontal } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";

export const metadata: Metadata = { title: "Settings" };

// /settings is a pure index, the same shape /chats and /calls already use: on
// mobile ShellColumns shows only the section list, on desktop this placeholder
// sits beside it. Profile lives at /settings/profile because it needs a detail
// route of its own — while it was the index, tapping "Profile" on a phone
// navigated to the route you were already on, so the editor was unreachable.
//
// Deliberately NOT a redirect to /settings/profile: SettingsPane's mobile back
// link points at /settings, so a redirect here would bounce straight back and
// loop.
export default function SettingsIndexPage() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<SlidersHorizontal size={28} />}
        title="Settings"
        description="Choose a section to get started."
      />
    </MainPane>
  );
}
