import type { Metadata } from "next";
import { Phone } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";

export const metadata: Metadata = { title: "Calls" };

// Desktop-only no-selection pane — on mobile /calls shows the list column.
export default function CallsPage() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<Phone size={40} />}
        title="Select someone to call"
        description="Open a chat and use the phone or camera icon in its header, or call someone back from your history."
      />
    </MainPane>
  );
}
