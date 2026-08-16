import { ConversationColumn } from "./conversation-column";
import { ShellColumns } from "@/components/features/shell/shell-columns";

// /chats and /u/[username] share the conversation column, so opening a profile
// from a search result keeps the list in place on desktop.
export default function MessagingLayout({ children }: { children: React.ReactNode }) {
  return (
    <ShellColumns list={<ConversationColumn />} detailPrefixes={["/u/"]}>
      {children}
    </ShellColumns>
  );
}
