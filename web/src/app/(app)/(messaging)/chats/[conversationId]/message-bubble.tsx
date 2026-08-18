import { Check, CircleAlert, Clock, FileText, Phone, RotateCw } from "lucide-react";
import { UserAvatar } from "@/components/features/profile/user-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ChatMember, ChatMessage } from "@/lib/chat/types";
import type { OutgoingMessage } from "../../../realtime-provider";
import { MessageActions } from "./message-actions";

// No "use client": rendered only from message-list.tsx, inside chat-thread's
// boundary.

export type BubbleRow = {
  message: ChatMessage;
  showHeader: boolean;
  isTail: boolean;
  pending?: OutgoingMessage;
};

export function MessageBubble({
  message,
  showHeader,
  isTail,
  sender,
  isOwn,
  status,
  error,
  onRetry,
  onDiscard,
}: {
  message: ChatMessage;
  showHeader: boolean;
  isTail: boolean;
  sender: ChatMember | undefined;
  isOwn: boolean;
  status?: "pending" | "failed" | "sent";
  error?: string;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  // SYSTEM and CALL are centred notices, never grouped and never avatared.
  if (message.type === "SYSTEM" || message.type === "CALL") {
    return (
      <li className="flex justify-center py-1.5">
        <span className="text-muted-foreground bg-muted/60 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs">
          {message.type === "CALL" && <Phone size={12} />}
          {message.body ?? (message.type === "CALL" ? "Call" : "")}
        </span>
      </li>
    );
  }

  const deleted = message.deletedAt !== null;

  // Only a real, saved, own message can be deleted — an optimistic bubble has
  // no server id yet, and a tombstone has nothing left to remove.
  const canDelete = isOwn && !deleted && !message.id.startsWith("pending:");

  return (
    <li className={cn("group flex gap-2", isOwn ? "flex-row-reverse" : "flex-row", isTail ? "mb-2" : "mb-0.5")}>
      <span className="w-8 shrink-0">
        {!isOwn && isTail && (
          <UserAvatar src={sender?.avatarUrl ?? null} firstName={sender?.firstName} lastName={sender?.lastName} size="sm" />
        )}
      </span>

      {canDelete && (
        <span className="self-center">
          <MessageActions messageId={message.id} />
        </span>
      )}

      <div className={cn("flex min-w-0 flex-col", isOwn ? "items-end" : "items-start")}>
        {showHeader && !isOwn && (
          <span className="text-muted-foreground mb-0.5 px-1 text-xs font-medium">
            {sender ? `${sender.firstName} ${sender.lastName ?? ""}`.trim() : "Unknown"}
          </span>
        )}

        <div
          className={cn(
            // Container-keyed, not viewport-keyed: at exactly 768px the rail and
            // list leave this pane ~208px, narrower than a phone.
            "max-w-[85%] rounded-2xl px-3 py-2 text-sm @md/pane:max-w-[75%] @2xl/pane:max-w-[60ch]",
            deleted
              ? "text-muted-foreground border bg-transparent italic"
              : isOwn
                ? "bg-primary text-primary-foreground rounded-br-md"
                : "bg-muted rounded-bl-md",
          )}
        >
          {deleted ? (
            "Message deleted"
          ) : (
            <MessageBody message={message} />
          )}
        </div>

        {isTail && (
          <span className="text-muted-foreground mt-0.5 flex items-center gap-1 px-1 text-[11px]">
            <time dateTime={message.createdAt} suppressHydrationWarning>
              {formatTime(message.createdAt)}
            </time>
            {isOwn && status === "pending" && <Clock size={12} aria-label="Sending" />}
            {isOwn && status === "sent" && <Check size={12} aria-label="Sent" />}
            {isOwn && status === "failed" && <CircleAlert size={12} className="text-destructive" aria-label="Not sent" />}
          </span>
        )}

        {status === "failed" && (
          // On the bubble, never also a toast: the optimistic message is still
          // on screen, so this is where the failure belongs.
          <span className="mt-0.5 flex items-center gap-1 px-1">
            <span className="text-destructive text-[11px]">{error ?? "Not sent"}</span>
            <Button type="button" size="xs" variant="ghost" onClick={onRetry}>
              <RotateCw /> Retry
            </Button>
            <Button type="button" size="xs" variant="ghost" onClick={onDiscard}>
              Discard
            </Button>
          </span>
        )}
      </div>
    </li>
  );
}

function MessageBody({ message }: { message: ChatMessage }) {
  switch (message.type) {
    case "IMAGE":
      return (
        // Plain <img>: next/image appears nowhere in this app, and Cloudinary
        // has already applied f_auto/q_auto. Fixed aspect box bounds the reflow
        // when it loads, since the schema carries no dimensions.
        <a href={message.mediaUrl ?? "#"} target="_blank" rel="noopener noreferrer" className="block">
          {/* eslint-disable-next-line @next/next/no-img-element -- next/image
              is used nowhere in this app by design: Cloudinary already applies
              f_auto,q_auto and a size, and /_next/image would re-proxy an
              already-optimised asset. Radix's AvatarImage is a plain <img> for
              the same reason. */}
          <img
            src={message.mediaUrl ?? ""}
            alt={message.mediaName ?? "Photo"}
            className="max-h-72 rounded-xl object-cover"
          />
        </a>
      );
    case "VIDEO":
      return (
        <video controls preload="metadata" playsInline className="max-h-72 rounded-xl">
          <source src={message.mediaUrl ?? ""} type={message.mediaMime ?? undefined} />
        </video>
      );
    case "FILE":
      return (
        <a
          href={message.mediaUrl ?? "#"}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 underline-offset-2 hover:underline"
        >
          <FileText size={16} className="shrink-0" />
          <span className="min-w-0 truncate">{message.mediaName ?? "File"}</span>
          {message.mediaSize !== null && <span className="shrink-0 text-xs opacity-70">{formatBytes(message.mediaSize)}</span>}
        </a>
      );
    default:
      // Plain JSX — React escapes it. Never dangerouslySetInnerHTML: this is
      // the entire XSS defence, same rule the bio field follows.
      return <span className="break-words whitespace-pre-wrap">{message.body}</span>;
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
