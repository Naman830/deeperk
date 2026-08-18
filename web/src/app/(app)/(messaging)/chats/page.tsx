import type { Metadata } from "next";
import { MessagesSquare } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";

export const metadata: Metadata = { title: "Chats" };

// The desktop no-selection pane. Below md, ShellColumns hides this entirely and
// shows the conversation list instead, so this copy is desktop-only in practice.
export default function ChatsPage() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<MessagesSquare size={40} />}
        title="Select a conversation"
        description="Pick a chat from the list, or search for someone by username to start a new one."
      />
    </MainPane>
  );
}
