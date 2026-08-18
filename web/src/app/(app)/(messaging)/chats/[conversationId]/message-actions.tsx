import { MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ChatMessage } from "@/lib/chat/types";
import { MessageMenuItems } from "./message-menu-items";

// No "use client": rendered from message-bubble.tsx.

/**
 * The keyboard path into a message's actions, and it is not optional.
 *
 * message-bubble.tsx also wraps the bubble in a ContextMenu for right-click and
 * long-press, but Radix's ContextMenu.Trigger renders a plain span and is never
 * focusable — the only keyboard route into one is the OS context-menu key,
 * which fires at the focused element, and a bubble is never focused. So a
 * context-menu-only design would be keyboard-unreachable. This button is the
 * answer to that, which is why it is opacity-0 rather than hidden: a hidden
 * control cannot be tabbed to either.
 */
export function MessageActions({
  message,
  viewerId,
  onReply,
  onCopy,
  onEdit,
  onForward,
  onSelect,
  onDeleteForMe,
  onDeleteForEveryone,
}: {
  message: ChatMessage;
  viewerId: string;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onSelect: () => void;
  onDeleteForMe: () => void;
  onDeleteForEveryone: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Message actions"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <MoreVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <MessageMenuItems
          message={message}
          viewerId={viewerId}
          itemAs={DropdownMenuItem}
          separatorAs={DropdownMenuSeparator}
          onReply={onReply}
          onCopy={onCopy}
          onEdit={onEdit}
          onForward={onForward}
          onSelect={onSelect}
          onDeleteForMe={onDeleteForMe}
          onDeleteForEveryone={onDeleteForEveryone}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
