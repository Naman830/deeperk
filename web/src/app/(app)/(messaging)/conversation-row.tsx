import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@/lib/chat/types";
import { ConversationAvatar } from "./conversation-avatar";

// No "use client": rendered from conversation-list.tsx, which is already inside
// the client boundary. `active` is computed once by the list rather than read
// from usePathname here, so this file stays free of hooks entirely.

type ConversationRowProps = {
  conversation: ConversationSummary;
  active: boolean;
  isOnline?: boolean;
  typingNames: string[];
  viewerId: string;
};

export function ConversationRow({ conversation, active, isOnline, typingNames, viewerId }: ConversationRowProps) {
  const title = conversationTitle(conversation);
  const unread = conversation.unreadCount;

  return (
    <li>
      <Link
        href={`/chats/${conversation.id}`}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 rounded-lg px-2 py-2 transition-colors",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50",
        )}
      >
        <ConversationAvatar conversation={conversation} isOnline={isOnline} />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <span className={cn("min-w-0 flex-1 truncate text-sm", unread > 0 ? "font-semibold" : "font-medium")}>
              {title}
            </span>
            <time
              dateTime={conversation.updatedAt}
              // Formatted on the client, so the server-rendered markup and the
              // hydrated output would otherwise disagree on timezone.
              suppressHydrationWarning
              className="text-muted-foreground shrink-0 text-[11px]"
            >
              {shortTime(conversation.updatedAt)}
            </time>
          </span>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                typingNames.length > 0 ? "text-primary italic" : "text-muted-foreground",
              )}
            >
              {typingNames.length > 0 ? typingLabel(typingNames) : preview(conversation, viewerId)}
            </span>
            {unread > 0 && (
              <Badge aria-label={`${unread} unread`} className="h-4 min-w-4 shrink-0 px-1 text-[10px] tabular-nums">
                {unread > 99 ? "99+" : unread}
              </Badge>
            )}
          </span>
        </span>
      </Link>
    </li>
  );
}

export function conversationTitle(conversation: ConversationSummary): string {
  if (conversation.type === "GROUP") return conversation.name ?? "Group";
  const other = conversation.otherUser;
  if (!other) return "Conversation";
  return `${other.firstName} ${other.lastName ?? ""}`.trim() || `@${other.displayUsername}`;
}

function typingLabel(names: string[]): string {
  if (names.length === 1) return `${names[0]} is typing…`;
  return "Several people are typing…";
}

function preview(conversation: ConversationSummary, viewerId: string): string {
  const last = conversation.lastMessage;
  if (!last) return "No messages yet";
  const mine = last.senderId === viewerId && last.type !== "SYSTEM";
  return mine ? `You: ${last.preview}` : last.preview;
}

// Lazily constructed so the module can be imported on the server without
// touching Intl at build time.
let timeFormat: Intl.DateTimeFormat | null = null;
let dateFormat: Intl.DateTimeFormat | null = null;

function shortTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
    return timeFormat.format(date);
  }
  dateFormat ??= new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
  return dateFormat.format(date);
}
