import type { Metadata } from "next";
import { MessagesSquare } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";

export const metadata: Metadata = { title: "Chats" };

// Placeholder until the Chat API exists (Docs/chat/chat.md — not built).
export default function ChatsPage() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<MessagesSquare size={40} />}
        title="Select a conversation"
        description="Real-time messaging isn't wired up yet. Search for someone to view their profile in the meantime."
      />
    </MainPane>
  );
}
