import { AtSign } from "lucide-react";
import { toast } from "react-toastify";

/**
 * The toast layer of chat.md §6, reworked.
 *
 * The owner's complaint was specific: *"again and again toast showing the
 * message and looking that awkward."* Three things address it, and only one of
 * them is in this file:
 *
 *  1. realtime-provider decides WHETHER to toast, and no longer consults
 *     document.hasFocus() for that decision — an open, visible thread never
 *     toasts, even in a window sitting behind another.
 *  2. Settings -> Notifications can turn toasts, sound and blink off outright,
 *     and a muted conversation stays silent.
 *  3. Here: one live toast per conversation (toastId), and a global cap of 3
 *     set on <ToastContainer limit={3}> — without it ten busy group chats can
 *     paper over the entire screen.
 */
export function notifyIncomingMessage({
  conversationId,
  title,
  preview,
  mentioned,
  onOpen,
}: {
  conversationId: string;
  title: string;
  preview: string;
  /** A direct @mention. Reaches you even from a muted conversation. */
  mentioned?: boolean;
  onOpen: () => void;
}) {
  const toastId = `msg:${conversationId}`;
  const body = (
    <span className="block min-w-0">
      <span className="flex items-center gap-1 truncate text-sm font-medium">
        {mentioned && <AtSign size={13} className="text-primary shrink-0" aria-label="Mentioned you" />}
        {title}
      </span>
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
