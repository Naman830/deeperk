import { memo, useState } from "react";
import { toast } from "react-toastify";
import { Check, CheckCheck, CircleAlert, Clock, FileText, Phone, Reply, RotateCw, Video } from "lucide-react";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { callBubbleText, parseCallBody } from "@/lib/call/call-message";
import { renderMessageBody } from "@/lib/chat/rich-text";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type { ChatMember, ChatMessage } from "@/lib/chat/types";
import type { DeleteScope, EditTarget, ReplyTarget } from "../../../realtime-provider";
import { MessageActions } from "./message-actions";
import { VoiceNotePlayer } from "./voice-note-player";
import { MessageMenuItems, canDeleteForEveryone, canReply } from "./message-menu-items";
import { DeleteMessageDialog } from "./delete-message-dialog";

// No "use client": rendered only from message-list.tsx, inside chat-thread's
// boundary.

export type TickState = "pending" | "sent" | "delivered" | "read" | "failed";

/** Where this bubble sits in a run of messages from the same sender. */
export type ClusterPosition = "single" | "first" | "middle" | "last";

function MessageBubbleImpl({
  message,
  entering,
  showHeader,
  isTail,
  cluster,
  sender,
  isOwn,
  viewerId,
  members,
  status,
  tick,
  error,
  exiting,
  highlighted,
  selectMode,
  selected,
  deleteMessage,
  setReply,
  setEdit,
  onToggleSelect,
  onEnterSelect,
  onForward,
  onJumpToMessage,
  replyPreview,
  onRetry,
  onDiscard,
}: {
  message: ChatMessage;
  /** The newest row. Animates in on mount; see message-list for why only one. */
  entering?: boolean;
  showHeader: boolean;
  isTail: boolean;
  cluster: ClusterPosition;
  sender: ChatMember | undefined;
  isOwn: boolean;
  viewerId: string;
  members: Map<string, ChatMember>;
  status?: "pending" | "failed" | "sent";
  tick?: TickState;
  error?: string;
  /** On its way out — collapse rather than vanish. See live-store's exitingIds. */
  exiting?: boolean;
  /** Flashed after a jump, so the eye can find the message it landed on. */
  highlighted?: boolean;
  selectMode?: boolean;
  selected?: boolean;
  /** The three realtime actions, passed as props (all stable useCallbacks) so
   *  this component never subscribes to the context — that subscription is
   *  what used to re-render every bubble on every socket event. */
  deleteMessage: (messageIds: string | string[], scope: DeleteScope) => Promise<string | null>;
  setReply: (conversationId: string, target: ReplyTarget | null) => void;
  setEdit: (conversationId: string, target: EditTarget | null) => void;
  onToggleSelect?: (messageId: string) => void;
  onEnterSelect?: (messageId: string) => void;
  onForward?: (messageId: string) => void;
  onJumpToMessage?: (messageId: string) => void;
  replyPreview?: { senderName: string; preview: string } | null;
  onRetry?: (clientMsgId: string) => void;
  onDiscard?: (clientMsgId: string) => void;
}) {
  // Hooks first: SYSTEM/CALL returns early below, and an early return above a
  // hook call changes hook order between renders.
  const [confirming, setConfirming] = useState(false);

  // SYSTEM and CALL are centred notices, never grouped and never avatared.
  if (message.type === "SYSTEM" || message.type === "CALL") {
    // Per-viewer wording derived from the body JSON + senderId — zero new
    // props, so the memo contract holds.
    const parsed = message.type === "CALL" ? parseCallBody(message.body) : null;
    return (
      <li className="flex justify-center py-1.5">
        <span className="text-muted-foreground bg-muted/60 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
          {message.type === "CALL" && (parsed?.kind === "VIDEO" ? <Video size={12} /> : <Phone size={12} />)}
          {message.type === "CALL"
            ? parsed
              ? callBubbleText(parsed, message.senderId === viewerId)
              : "Call"
            : (message.body ?? "")}
        </span>
      </li>
    );
  }

  const deleted = message.deletedAt !== null;
  const pending = message.id.startsWith("pending:");
  const forEveryone = canDeleteForEveryone(message, viewerId);
  const senderName = sender ? `${sender.firstName} ${sender.lastName ?? ""}`.trim() : "Unknown";

  const openConfirm = () => setConfirming(true);
  const confirm = (scope: DeleteScope) => deleteMessage(message.id, scope);

  const startReply = () =>
    setReply(message.conversationId, {
      messageId: message.id,
      senderName: isOwn ? "You" : senderName,
      preview: previewOf(message),
    });

  const startEdit = () => setEdit(message.conversationId, { messageId: message.id, body: message.body ?? "" });

  const copy = async () => {
    const ok = await copyText(message.body ?? "");
    // A toast, not an inline error: by the time this resolves the menu that
    // launched it has already closed, so there is no control left to attach to.
    toast[ok ? "success" : "error"](ok ? "Copied" : "Couldn't copy");
  };

  const menuProps = {
    message,
    viewerId,
    onReply: startReply,
    onCopy: () => void copy(),
    onEdit: startEdit,
    onForward: () => onForward?.(message.id),
    onSelect: () => onEnterSelect?.(message.id),
    onDeleteForMe: openConfirm,
    onDeleteForEveryone: openConfirm,
  };

  // Telegram-style cluster corners: a run of messages from one sender reads as
  // one block, with only the outer corners fully rounded. The inner radius is
  // kept non-zero (rounded-md, not rounded-none) so the seams stay visible.
  const corner = isOwn
    ? {
        single: "rounded-2xl rounded-br-md",
        first: "rounded-2xl rounded-br-md",
        middle: "rounded-2xl rounded-r-md",
        last: "rounded-2xl rounded-tr-md rounded-br-md",
      }[cluster]
    : {
        single: "rounded-2xl rounded-bl-md",
        first: "rounded-2xl rounded-bl-md",
        middle: "rounded-2xl rounded-l-md",
        last: "rounded-2xl rounded-tl-md rounded-bl-md",
      }[cluster];

  const bubble = (
    <div
      data-message-id={message.id}
      className={cn(
        // cqw against @container/pane, not a percentage of the flex row: a
        // percentage resolves against whatever the gutter leaves behind, which
        // differs between own and received rows, so identical text rendered at
        // two different widths on adjacent rows. Still container-keyed, never
        // viewport-keyed — at 768px the rail and list leave this pane ~208px.
        // min-w-16 stops a two-character message rendering narrower than its own
        // timestamp row.
        "relative min-w-16 max-w-[min(85cqw,60ch)] px-3 py-1.5 text-sm @md/pane:max-w-[min(75cqw,60ch)]",
        "transition-[background-color,box-shadow] duration-200",
        corner,
        deleted
          ? "text-muted-foreground border bg-transparent italic"
          : isOwn
            ? "bg-primary text-primary-foreground"
            : "bg-muted",
        pending && "opacity-70",
        // The jump target flash: a ring rather than a background change, so it
        // reads on both bubble colours without touching the palette.
        highlighted && "ring-primary/60 ring-2 ring-offset-2 ring-offset-transparent",
      )}
    >
      {/* Quoted message. Inside the bubble with a left accent bar — Telegram's
          shape, and the one that survives a narrow pane, since a quote rendered
          above the bubble would be capped independently and misalign. */}
      {replyPreview && !deleted && (
        <button
          type="button"
          onClick={() => message.replyToId && onJumpToMessage?.(message.replyToId)}
          className={cn(
            "mb-1 flex w-full min-w-0 flex-col rounded-md border-l-2 px-2 py-1 text-left text-xs",
            isOwn
              ? "border-primary-foreground/60 bg-primary-foreground/10"
              : "border-primary bg-background/50",
          )}
        >
          <span className="truncate font-medium">{replyPreview.senderName}</span>
          <span className="truncate opacity-80">{replyPreview.preview}</span>
        </button>
      )}

      {deleted ? "Message deleted" : <MessageBody message={message} members={members} viewerId={viewerId} />}

      {/* Trailing metadata, inline.
          The absolutely-positioned time plus a transparent same-width spacer is
          the standard messenger trick: it lets a short last line sit beside the
          timestamp instead of below it, without a real CSS float — which breaks
          the moment the last line is one long unbroken URL, and the autolinker
          makes those likely. */}
      {isTail && !deleted && (
        <>
          <span aria-hidden className="pointer-events-none inline-block h-0 select-none" style={{ width: metaWidth(isOwn) }} />
          <span
            className={cn(
              "absolute right-3 bottom-1.5 flex items-center gap-1 text-[10px] leading-none",
              isOwn ? "text-primary-foreground/70" : "text-muted-foreground",
            )}
          >
            {message.editedAt && <span className="italic">edited</span>}
            <time dateTime={message.createdAt} suppressHydrationWarning>
              {formatTime(message.createdAt)}
            </time>
            {isOwn && <Tick state={tick ?? (status === "failed" ? "failed" : status === "pending" ? "pending" : "sent")} />}
          </span>
        </>
      )}
    </div>
  );

  const interactive = !selectMode && !pending;

  return (
    <li
      className={cn(
        "group relative flex gap-2",
        isOwn ? "flex-row-reverse" : "flex-row",
        isTail ? "mb-2" : "mb-0.5",
        selectMode && "cursor-pointer",
        selected && "bg-primary/5",
        // The exit collapse. grid-template-rows 1fr -> 0fr animates a row to
        // zero height without knowing what that height is, which is the only
        // way to do it for content this variable. Paired with EXIT_MS in
        // live-store.ts — change one, change both.
        "transition-[opacity,transform] duration-[180ms] ease-out",
        exiting && "pointer-events-none -translate-y-1 scale-[0.97] opacity-0",
        entering && !exiting && "animate-message-in",
      )}
      onClick={selectMode ? () => onToggleSelect?.(message.id) : undefined}
    >
      {/* Two fixed slots, identical on own and received rows — that symmetry is
          the whole point. Previously the avatar gutter was reserved even on own
          rows (where no avatar ever renders) AND own rows added a third actions
          column, so the same text measured ~32px narrower on an own bubble than
          on a received one. Clustering empties this slot on non-tail rows; it
          must STAY reserved there, or the fix unravels. */}
      <span className="flex w-8 shrink-0 items-end justify-center">
        {selectMode ? (
          <Checkbox checked={selected} aria-label="Select message" className="mb-2" />
        ) : (
          !isOwn && isTail && (
            <UserAvatar src={sender?.avatarUrl ?? null} firstName={sender?.firstName} lastName={sender?.lastName} size="sm" />
          )
        )}
      </span>

      {/* Container-keyed, not viewport-keyed. Below a ~448px pane this slot is
          gone entirely — that is 24px + a gap handed back to the bubble on a
          phone, where the buttons are useless anyway because there is no hover.
          Long-press opens the same menu there. */}
      <span className="hidden shrink-0 items-center gap-0.5 @md/pane:flex">
        {interactive && (
          <>
            {canReply(message) && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Reply"
                onClick={startReply}
                className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              >
                <Reply />
              </Button>
            )}
            <MessageActions {...menuProps} />
          </>
        )}
      </span>

      <div className={cn("flex min-w-0 flex-col", isOwn ? "items-end" : "items-start")}>
        {showHeader && !isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">{senderName}</span>
        )}

        {interactive ? (
          // Radix's ContextMenu.Trigger already implements right-click and a
          // 700ms long-press for touch/pen, cancelled on pointermove — so no
          // hand-rolled long-press timer. It wraps only the bubble, not the
          // whole <li>, or it would swallow right-click over the avatar gutter
          // and over the failed-send Retry/Discard buttons.
          <ContextMenu>
            <ContextMenuTrigger asChild>{bubble}</ContextMenuTrigger>
            <ContextMenuContent className="w-48">
              <MessageMenuItems {...menuProps} itemAs={ContextMenuItem} separatorAs={ContextMenuSeparator} />
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          bubble
        )}

        {status === "failed" && (
          // On the bubble, never also a toast: the optimistic message is still
          // on screen, so this is where the failure belongs.
          <span className="mt-0.5 flex items-center gap-1 px-1">
            <span className="text-destructive text-[11px]">{error ?? "Not sent"}</span>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => message.clientMsgId && onRetry?.(message.clientMsgId)}
            >
              <RotateCw /> Retry
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => message.clientMsgId && onDiscard?.(message.clientMsgId)}
            >
              Discard
            </Button>
          </span>
        )}
      </div>

      <DeleteMessageDialog
        open={confirming}
        onOpenChange={setConfirming}
        canDeleteForEveryone={forEveryone}
        onConfirm={confirm}
      />
    </li>
  );
}

/**
 * Memoized so typing, receipt and presence traffic — which re-renders the
 * whole MessageList — skips the bubbles whose props didn't change. Every
 * function prop must stay identity-stable (id-taking parent callbacks, never
 * per-row closures) or this silently degrades to re-rendering everything.
 */
export const MessageBubble = memo(MessageBubbleImpl);

function Tick({ state }: { state: TickState }) {
  switch (state) {
    case "pending":
      return <Clock size={12} aria-label="Sending" />;
    case "failed":
      return <CircleAlert size={12} className="text-destructive" aria-label="Not sent" />;
    case "delivered":
      return <CheckCheck size={13} aria-label="Delivered" />;
    case "read":
      // The blue tick. --success rather than the palette's primary, which on an
      // own bubble IS the background — a primary tick would be invisible.
      return <CheckCheck size={13} className="text-success" aria-label="Read" />;
    default:
      return <Check size={12} aria-label="Sent" />;
  }
}

/** Roughly the width of the inline metadata, reserved on the bubble's last line. */
function metaWidth(isOwn: boolean): string {
  return isOwn ? "4.25rem" : "2.75rem";
}

function MessageBody({
  message,
  members,
  viewerId,
}: {
  message: ChatMessage;
  members: Map<string, ChatMember>;
  viewerId: string;
}) {
  switch (message.type) {
    case "IMAGE":
      return (
        // Plain <img>: next/image appears nowhere in this app, and Cloudinary
        // has already applied f_auto/q_auto.
        <a href={message.mediaUrl ?? "#"} target="_blank" rel="noopener noreferrer" className="-mx-1 block">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image
              is used nowhere in this app by design: Cloudinary already applies
              f_auto,q_auto and a size, and /_next/image would re-proxy an
              already-optimised asset. Radix's AvatarImage is a plain <img> for
              the same reason. */}
          <img
            src={message.mediaUrl ?? ""}
            alt={message.mediaName ?? "Photo"}
            // width/height, not just CSS: with both present the browser knows
            // the aspect ratio before a byte of the image arrives and reserves
            // the box, so the thread stops jumping on every load — which also
            // stops re-triggering use-stick-to-bottom's ResizeObserver.
            // Null for anything uploaded before the columns existed, which
            // simply falls back to the old reflow-on-load behaviour.
            width={message.mediaWidth ?? undefined}
            height={message.mediaHeight ?? undefined}
            loading="lazy"
            decoding="async"
            className="h-auto max-h-72 w-auto max-w-full rounded-xl object-cover"
          />
        </a>
      );
    case "VIDEO":
      return (
        <video controls preload="metadata" playsInline className="-mx-1 max-h-72 max-w-full rounded-xl">
          <source src={message.mediaUrl ?? ""} type={message.mediaMime ?? undefined} />
        </video>
      );
    case "AUDIO":
      // Fixed height, so no aspect-box reservation — but an explicit width:
      // without one the bubble collapses to its min-w-16.
      return (
        <VoiceNotePlayer
          src={message.mediaUrl ?? ""}
          mime={message.mediaMime}
          durationMs={message.mediaDurationMs}
        />
      );
    case "FILE":
      return (
        <a
          href={message.mediaUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 py-0.5 underline-offset-2 hover:underline"
        >
          <FileText size={16} className="shrink-0" />
          <span className="min-w-0 truncate">{message.mediaName ?? "File"}</span>
          {message.mediaSize !== null && (
            <span className="shrink-0 text-xs opacity-70">{formatBytes(message.mediaSize)}</span>
          )}
        </a>
      );
    default:
      // renderMessageBody returns plain JSX built from strings — links and
      // mentions as elements, everything else as text. Never
      // dangerouslySetInnerHTML: that is the entire XSS defence, same rule the
      // bio field follows.
      return (
        <span className="break-words whitespace-pre-wrap">
          {renderMessageBody(message.body ?? "", {
            members,
            viewerUsername: members.get(viewerId)?.username,
          })}
        </span>
      );
  }
}

function previewOf(message: ChatMessage): string {
  switch (message.type) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "FILE":
      return message.mediaName ?? "File";
    case "AUDIO":
      return "Voice message";
    default:
      return (message.body ?? "").slice(0, 100);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let timeFormat: Intl.DateTimeFormat | null = null;
function formatTime(iso: string): string {
  timeFormat ??= new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
  return timeFormat.format(new Date(iso));
}
