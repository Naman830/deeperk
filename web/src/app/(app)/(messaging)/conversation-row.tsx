import { useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import { Archive, ArchiveRestore, BellOff, BellRing, Eraser, Pin, PinOff, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useNow, isMuted } from "@/lib/hooks/use-now";
import { cn } from "@/lib/utils";
import type { ConversationSummary } from "@/lib/chat/types";
import { useRealtime } from "../realtime-provider";
import { ConversationAvatar } from "./conversation-avatar";

// No "use client": rendered from conversation-list.tsx, which is already inside
// the client boundary. `active` is computed once by the list rather than read
// from usePathname here.

type ConversationRowProps = {
  conversation: ConversationSummary;
  active: boolean;
  isOnline?: boolean;
  typingNames: string[];
  viewerId: string;
};

export function ConversationRow({ conversation, active, isOnline, typingNames, viewerId }: ConversationRowProps) {
  const { setConversationState, clearConversation } = useRealtime();
  const [confirm, setConfirm] = useState<"clear" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  const title = conversationTitle(conversation);
  const unread = conversation.unreadCount;
  const pinned = conversation.pinnedAt !== null;
  const archived = conversation.archivedAt !== null;
  const muted = isMuted(conversation.mutedUntil, now);

  async function run(action: () => Promise<string | null>, success: string) {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    setConfirm(null);
    if (failure) toast.error(failure);
    else toast.success(success);
  }

  const row = (
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
        <span className="flex items-center gap-1.5">
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              typingNames.length > 0 ? "text-primary italic" : "text-muted-foreground",
            )}
          >
            {typingNames.length > 0 ? typingLabel(typingNames) : preview(conversation, viewerId)}
          </span>
          {pinned && <Pin size={11} className="text-muted-foreground shrink-0" aria-label="Pinned" />}
          {muted && <BellOff size={11} className="text-muted-foreground shrink-0" aria-label="Muted" />}
          {unread > 0 && (
            <Badge
              aria-label={`${unread} unread`}
              className={cn(
                "h-4 min-w-4 shrink-0 px-1 text-[10px] tabular-nums",
                // A muted chat still counts, but quietly — the badge is the one
                // thing a mute should not make shout.
                muted && "bg-muted-foreground/60",
              )}
            >
              {unread > 99 ? "99+" : unread}
            </Badge>
          )}
        </span>
      </span>
    </Link>
  );

  return (
    <li>
      {/* Radix's ContextMenu.Trigger gives right-click AND a 700ms long-press on
          touch for free, so the row's actions are reachable on a phone without a
          hand-rolled gesture. The trigger is not focusable, so this is a
          shortcut rather than the only path — every action here also lives in
          the thread's own header menu, which is fully keyboard-reachable. */}
      <ContextMenu>
        <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
        <ContextMenuContent className="w-48">
          <ContextMenuItem
            onSelect={() =>
              void run(
                () => setConversationState(conversation.id, { pinned: !pinned }),
                pinned ? "Unpinned" : "Pinned to top",
              )
            }
          >
            {pinned ? <PinOff /> : <Pin />} {pinned ? "Unpin" : "Pin to top"}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              void run(
                () => setConversationState(conversation.id, { muteMinutes: muted ? null : 60 * 24 * 365 * 100 }),
                muted ? "Unmuted" : "Muted",
              )
            }
          >
            {muted ? <BellRing /> : <BellOff />} {muted ? "Unmute" : "Mute"}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              void run(
                () => setConversationState(conversation.id, { archived: !archived }),
                archived ? "Unarchived" : "Archived",
              )
            }
          >
            {archived ? <ArchiveRestore /> : <Archive />} {archived ? "Unarchive" : "Archive"}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuItem onSelect={() => setConfirm("clear")}>
            <Eraser /> Clear chat
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
            <Trash2 /> Delete chat
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "clear" ? "Clear this chat?" : "Delete this chat?"}</AlertDialogTitle>
            {/* Says plainly that this affects only you — the single thing people
                get wrong about these two controls. */}
            <AlertDialogDescription>
              {confirm === "clear"
                ? "Every message will be removed from your copy of this chat. The other side keeps theirs, and new messages will still arrive."
                : "This chat leaves your list and its history is cleared for you. The other side keeps theirs — if they message you again, the chat comes back with just the new messages."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // preventDefault is load-bearing: AlertDialogAction closes the
              // dialog synchronously on click, so without it the busy state
              // renders into a dialog that is already unmounting.
              onClick={(event) => {
                event.preventDefault();
                if (!confirm) return;
                void run(
                  () => clearConversation(conversation.id, confirm),
                  confirm === "clear" ? "Chat cleared" : "Chat deleted",
                );
              }}
              disabled={busy}
            >
              {busy ? "Working…" : confirm === "clear" ? "Clear chat" : "Delete chat"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
