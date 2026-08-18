import Link from "next/link";
import { MessageSquareOff } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { EmptyState } from "@/components/features/shell/empty-state";
import { Button } from "@/components/ui/button";

// Scoped to this segment so the shell survives. Without it, notFound() bubbles
// past u/[username]/not-found.tsx (scoped elsewhere) to the root one, which
// replaces the whole app chrome.
export default function ConversationNotFound() {
  return (
    <MainPane centered>
      <EmptyState
        icon={<MessageSquareOff size={40} />}
        title="Conversation not found"
        description="It may have been deleted, or you're no longer a member."
        action={
          <Button asChild variant="outline">
            <Link href="/chats">Back to chats</Link>
          </Button>
        }
      />
    </MainPane>
  );
}
