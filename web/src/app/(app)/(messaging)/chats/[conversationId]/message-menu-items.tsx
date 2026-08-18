import { CheckSquare, Copy, Forward, Pencil, Reply, Trash2, EyeOff } from "lucide-react";
import type { ChatMessage } from "@/lib/chat/types";

// No "use client": rendered from message-bubble.tsx, inside chat-thread's boundary.

/**
 * The one definition of what a message's menu contains.
 *
 * It is rendered into two different menus — the hover DropdownMenu and the
 * long-press/right-click ContextMenu — whose Item components are distinct React
 * components with an identical prop surface. Passing the component in beats
 * duplicating the list, which would drift the first time an item is added. It
 * has now been added to five times, which is the argument.
 */
export type MenuItemComponent = React.ComponentType<{
  children: React.ReactNode;
  variant?: "default" | "destructive";
  onSelect?: (event: Event) => void;
}>;

export type MenuSeparatorComponent = React.ComponentType<Record<string, never>>;

const PENDING = "pending:";

/** Own, saved, not-yet-deleted messages are the only ones you can unsend. */
export function canDeleteForEveryone(message: ChatMessage, viewerId: string): boolean {
  return message.senderId === viewerId && message.deletedAt === null && !message.id.startsWith(PENDING);
}

/** A tombstone has nothing left to hide, and an optimistic bubble has no server id. */
export function canDeleteForMe(message: ChatMessage): boolean {
  return !message.id.startsWith(PENDING);
}

/** TEXT only: an edit rewrites `body`, and a photo has none. */
export function canEdit(message: ChatMessage, viewerId: string): boolean {
  return (
    message.senderId === viewerId &&
    message.type === "TEXT" &&
    message.deletedAt === null &&
    !message.id.startsWith(PENDING)
  );
}

/** You can reply to anyone's message, but not to a tombstone or a pending one. */
export function canReply(message: ChatMessage): boolean {
  return message.deletedAt === null && !message.id.startsWith(PENDING) && message.type !== "SYSTEM";
}

export function canCopy(message: ChatMessage): boolean {
  return message.type === "TEXT" && message.deletedAt === null && (message.body?.length ?? 0) > 0;
}

export function MessageMenuItems({
  message,
  viewerId,
  itemAs: Item,
  separatorAs: Separator,
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
  itemAs: MenuItemComponent;
  separatorAs?: MenuSeparatorComponent;
  onReply: () => void;
  onCopy: () => void;
  onEdit: () => void;
  onForward: () => void;
  onSelect: () => void;
  onDeleteForMe: () => void;
  onDeleteForEveryone: () => void;
}) {
  const saved = !message.id.startsWith(PENDING);
  return (
    <>
      {canReply(message) && (
        <Item onSelect={onReply}>
          <Reply /> Reply
        </Item>
      )}
      {canCopy(message) && (
        <Item onSelect={onCopy}>
          <Copy /> Copy
        </Item>
      )}
      {canEdit(message, viewerId) && (
        <Item onSelect={onEdit}>
          <Pencil /> Edit
        </Item>
      )}
      {saved && message.deletedAt === null && (
        <Item onSelect={onForward}>
          <Forward /> Forward
        </Item>
      )}
      {saved && (
        <Item onSelect={onSelect}>
          <CheckSquare /> Select
        </Item>
      )}
      {Separator && saved && <Separator />}
      {canDeleteForMe(message) && (
        <Item onSelect={onDeleteForMe}>
          <EyeOff /> Delete for me
        </Item>
      )}
      {canDeleteForEveryone(message, viewerId) && (
        <Item variant="destructive" onSelect={onDeleteForEveryone}>
          <Trash2 /> Delete for everyone
        </Item>
      )}
    </>
  );
}
