import { useState } from "react";
import { toast } from "react-toastify";
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
import type { DeleteScope } from "../../../realtime-provider";

// No "use client": rendered from message-bubble.tsx (single delete) and
// chat-thread.tsx (bulk selection delete), both inside the thread's boundary.

/**
 * WhatsApp's three-way delete: for me / for everyone / cancel.
 *
 * AlertDialog rather than Dialog, unchanged from before: this is a destructive
 * confirm, so it needs role="alertdialog" and must not dismiss on a stray
 * outside click.
 */
export function DeleteMessageDialog({
  open,
  onOpenChange,
  canDeleteForEveryone,
  count = 1,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canDeleteForEveryone: boolean;
  /** More than one when a multi-select is being deleted. */
  count?: number;
  onConfirm: (scope: DeleteScope) => Promise<string | null>;
}) {
  const [busy, setBusy] = useState<DeleteScope | null>(null);

  async function run(scope: DeleteScope) {
    setBusy(scope);
    const error = await onConfirm(scope);
    setBusy(null);
    onOpenChange(false);
    // The dialog is gone by the time this resolves, so a toast is the only
    // channel left — there is no control to attach an inline error to.
    if (error) toast.error(error);
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{count > 1 ? `Delete ${count} messages?` : "Delete message?"}</AlertDialogTitle>
          <AlertDialogDescription>
            {canDeleteForEveryone
              ? count > 1
                ? "Remove them just for you, or for everyone in this conversation."
                : "Remove it just for you, or for everyone in this conversation."
              : count > 1
                ? "They will be removed for you only. Everyone else will still see them."
                : "It will be removed for you only. Everyone else will still see it."}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* A vertical stack at every width. The default footer is
            flex-col-reverse sm:flex-row, which reads badly with two adjacent
            actions that differ only in scope. */}
        <AlertDialogFooter className="gap-2 sm:flex-col sm:space-x-0">
          {canDeleteForEveryone && (
            <AlertDialogAction
              // preventDefault is load-bearing: AlertDialogAction is Radix's
              // Action, which closes the dialog synchronously on click. Without
              // this the busy state renders into a dialog that is already
              // unmounting, and the buttons can be clicked twice mid-flight.
              onClick={(event) => {
                event.preventDefault();
                void run("everyone");
              }}
              disabled={busy !== null}
            >
              {busy === "everyone" ? "Deleting…" : "Delete for everyone"}
            </AlertDialogAction>
          )}
          <AlertDialogAction
            onClick={(event) => {
              event.preventDefault();
              void run("me");
            }}
            disabled={busy !== null}
          >
            {busy === "me" ? "Removing…" : "Delete for me"}
          </AlertDialogAction>
          <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
