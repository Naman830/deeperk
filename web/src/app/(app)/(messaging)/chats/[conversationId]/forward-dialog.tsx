import { useState } from "react";
import { toast } from "react-toastify";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConversationPicker } from "@/components/features/messaging/conversation-picker";
import { useRealtime } from "../../../realtime-provider";

// No "use client": rendered from chat-thread.tsx.

export function ForwardDialog({
  open,
  onOpenChange,
  messageIds,
  fromConversationId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageIds: string[];
  fromConversationId: string;
  onDone?: () => void;
}) {
  const { conversations, forwardMessages } = useRealtime();
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    if (!target) return;
    setBusy(true);
    const failure = await forwardMessages(target, messageIds);
    setBusy(false);
    onOpenChange(false);
    setTarget(null);
    // The dialog is gone by the time this resolves, so a toast is the only
    // channel left — there is no control to attach an inline error to.
    if (failure) toast.error(failure);
    else {
      toast.success(messageIds.length === 1 ? "Message forwarded" : `${messageIds.length} messages forwarded`);
      onDone?.();
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {messageIds.length === 1 ? "Forward message" : `Forward ${messageIds.length} messages`}
          </DialogTitle>
          <DialogDescription>Choose a chat to send it to.</DialogDescription>
        </DialogHeader>

        <ConversationPicker
          conversations={conversations}
          selectedId={target}
          onSelect={setTarget}
          excludeId={fromConversationId}
        />

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void send()} disabled={!target || busy}>
            {busy ? "Forwarding…" : "Forward"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
