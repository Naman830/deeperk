import { useState } from "react";
import { toast } from "react-toastify";
import {
  Ban,
  BellOff,
  BellRing,
  Eraser,
  Images,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiDelete, apiPost } from "@/lib/api-client";
import { useNow, isMuted } from "@/lib/hooks/use-now";
import type { ConversationDetail } from "@/lib/chat/types";
import { useRealtime } from "../../../realtime-provider";

// No "use client": rendered from thread-header.tsx.

const MUTE_OPTIONS: { label: string; minutes: number | null }[] = [
  { label: "For 1 hour", minutes: 60 },
  { label: "For 8 hours", minutes: 60 * 8 },
  { label: "For 1 week", minutes: 60 * 24 * 7 },
  // Not "forever" — a real timestamp a century out. mutedUntil is a timestamp
  // rather than a boolean precisely so "8 hours" is expressible, and a null
  // sentinel for "always" would have needed a second column to disambiguate.
  { label: "Until I turn it back on", minutes: 60 * 24 * 365 * 100 },
];

type Confirm = "clear" | "delete" | "block" | null;

export function ConversationMenu({
  conversation,
  otherUsername,
  onOpenSearch,
  onOpenMedia,
}: {
  conversation: ConversationDetail;
  otherUsername?: string;
  onOpenSearch: () => void;
  onOpenMedia: () => void;
}) {
  const { conversations, setConversationState, clearConversation } = useRealtime();
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const now = useNow();

  // The sidebar summary is the live copy — the server-rendered ConversationDetail
  // was correct at page load and does not follow a pin or mute made since.
  const summary = conversations.find((item) => item.id === conversation.id);
  const pinned = (summary?.pinnedAt ?? conversation.pinnedAt) !== null;
  const mutedUntilRaw = summary?.mutedUntil ?? conversation.mutedUntil;
  const muted = isMuted(mutedUntilRaw, now);

  async function run(action: () => Promise<string | null>, success: string) {
    setBusy(true);
    const failure = await action();
    setBusy(false);
    setConfirm(null);
    if (failure) toast.error(failure);
    else toast.success(success);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Conversation options">
            <MoreVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onSelect={onOpenSearch}>
            <Search /> Search in chat
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onOpenMedia}>
            <Images /> Media, links & files
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            onSelect={() =>
              void run(
                () => setConversationState(conversation.id, { pinned: !pinned }),
                pinned ? "Unpinned" : "Pinned to top",
              )
            }
          >
            {pinned ? <PinOff /> : <Pin />} {pinned ? "Unpin chat" : "Pin chat"}
          </DropdownMenuItem>

          {muted ? (
            <DropdownMenuItem
              onSelect={() => void run(() => setConversationState(conversation.id, { muteMinutes: null }), "Unmuted")}
            >
              <BellRing /> Unmute
            </DropdownMenuItem>
          ) : (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <BellOff /> Mute
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {MUTE_OPTIONS.map((option) => (
                  <DropdownMenuItem
                    key={option.label}
                    onSelect={() =>
                      void run(
                        () => setConversationState(conversation.id, { muteMinutes: option.minutes }),
                        "Muted",
                      )
                    }
                  >
                    {option.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem onSelect={() => setConfirm("clear")}>
            <Eraser /> Clear chat
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("delete")}>
            <Trash2 /> Delete chat
          </DropdownMenuItem>
          {conversation.type === "DIRECT" && otherUsername && (
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirm("block")}>
              <Ban /> Block
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "clear" ? "Clear this chat?" : confirm === "delete" ? "Delete this chat?" : "Block this person?"}
            </AlertDialogTitle>
            {/* The copy states plainly that clear and delete affect only you.
                That is the single thing people get wrong about these controls,
                and it is not recoverable once they have acted on the wrong
                belief. */}
            <AlertDialogDescription>
              {confirm === "clear"
                ? "Every message will be removed from your copy of this chat. The other side keeps theirs, and new messages will still arrive."
                : confirm === "delete"
                  ? "This chat leaves your list and its history is cleared for you. The other side keeps theirs — if they message you again, the chat comes back with just the new messages."
                  : "They won't be able to message you or start new chats with you, and you won't see each other in search. You can undo this from their profile."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              // preventDefault is load-bearing: AlertDialogAction is Radix's
              // Action, which closes the dialog synchronously on click. Without
              // it the busy state renders into a dialog that is already
              // unmounting, and the button can be pressed twice mid-flight.
              onClick={(event) => {
                event.preventDefault();
                if (confirm === "block") {
                  void run(async () => {
                    const result = await apiPost(`/api/users/${otherUsername}/block`);
                    return result.ok ? null : (result.data.error ?? "Couldn't block");
                  }, "Blocked");
                  return;
                }
                if (confirm === "clear" || confirm === "delete") {
                  void run(
                    () => clearConversation(conversation.id, confirm),
                    confirm === "clear" ? "Chat cleared" : "Chat deleted",
                  );
                }
              }}
              disabled={busy}
            >
              {busy ? "Working…" : confirm === "clear" ? "Clear chat" : confirm === "delete" ? "Delete chat" : "Block"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** Exported so a profile page can undo a block without importing the dialog. */
export async function unblockUser(username: string): Promise<string | null> {
  const result = await apiDelete(`/api/users/${username}/block`);
  return result.ok ? null : (result.data.error ?? "Couldn't unblock");
}
