import { toast } from "react-toastify";

/**
 * The toast layer of chat.md §6.
 *
 * This is the repo's first toast call with an options object and with non-string
 * content — every other call site is a bare `toast.error("...")`. Both are
 * needed here and neither is stylistic: without a per-conversation `toastId`, a
 * burst of thirty group messages stacks thirty toasts over the chat header, and
 * without `onClick` the toast can't take you to the conversation it's about.
 * Existing call sites stay exactly as they are.
 */
export function notifyIncomingMessage({
  conversationId,
  title,
  preview,
  onOpen,
}: {
  conversationId: string;
  title: string;
  preview: string;
  onOpen: () => void;
}) {
  const toastId = `msg:${conversationId}`;
  const body = (
    <span className="block min-w-0">
      <span className="block truncate text-sm font-medium">{title}</span>
      <span className="text-muted-foreground block truncate text-xs">{preview}</span>
    </span>
  );

  // One live toast per conversation: replace its contents rather than stacking.
  if (toast.isActive(toastId)) {
    toast.update(toastId, { render: body });
    return;
  }
  toast.info(body, { toastId, onClick: onOpen, autoClose: 5000 });
}

export function notifyAddedToConversation({ conversationId, title }: { conversationId: string; title: string }) {
  toast.info(title, { toastId: `conv:${conversationId}`, autoClose: 5000 });
}
