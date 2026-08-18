import { ConversationColumn } from "./conversation-column";
import { ShellColumns } from "@/components/features/shell/shell-columns";

// /chats, /chats/[id] and /u/[username] share the conversation column, so
// opening a profile from a search result keeps the list in place on desktop.
export default function MessagingLayout({ children }: { children: React.ReactNode }) {
  return (
    // Trailing slash on "/chats/" so /chats stays the index and only a thread
    // counts as a detail route. Without this entry the thread renders behind
    // the list on mobile and is unreachable — the same bug calls/layout.tsx
    // documents.
    <ShellColumns list={<ConversationColumn />} detailPrefixes={["/u/", "/chats/"]}>
      {children}
    </ShellColumns>
  );
}
