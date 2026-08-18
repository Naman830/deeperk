import { Copy, Forward, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";

// No "use client": rendered from chat-thread.tsx.

/**
 * Replaces the thread header while messages are selected.
 *
 * Selection state lives in chat-thread rather than the provider, deliberately:
 * it must NOT survive a conversation switch. Carrying a selection from one chat
 * into another and then hitting Delete is exactly the kind of mistake that
 * cannot be undone.
 */
export function SelectionBar({
  count,
  onCopy,
  onForward,
  onDelete,
  onCancel,
}: {
  count: number;
  onCopy: () => void;
  onForward: () => void;
  onDelete: () => void;
  onCancel: () => void;
}) {
  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-1 border-b px-2 md:px-4">
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Cancel selection" onClick={onCancel}>
        <X />
      </Button>
      <span className="flex-1 text-sm font-medium tabular-nums">
        {count} selected
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Copy" onClick={onCopy}>
        <Copy />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Forward" onClick={onForward}>
        <Forward />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Delete"
        onClick={onDelete}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 />
      </Button>
    </header>
  );
}
