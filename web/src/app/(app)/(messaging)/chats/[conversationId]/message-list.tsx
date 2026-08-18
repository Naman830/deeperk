import type { ChatMember, ChatMessage } from "@/lib/chat/types";
import type { OutgoingMessage, Receipt } from "../../../realtime-provider";
import { MessageBubble, type ClusterPosition, type TickState } from "./message-bubble";

// No "use client": rendered from chat-thread.tsx, inside its boundary.

const GROUPING_WINDOW_MS = 5 * 60 * 1000;

type Row =
  | { kind: "date"; key: string; label: string }
  | { kind: "unread"; key: string; count: number }
  | {
      kind: "message";
      key: string;
      message: ChatMessage;
      showHeader: boolean;
      isTail: boolean;
      cluster: ClusterPosition;
    };

/**
 * One walk over the array — grouping, separators and the unread divider are all
 * derived, never state.
 *
 * A cluster breaks on: a change of sender, a gap over five minutes, a day
 * boundary, the unread divider, and any SYSTEM/CALL notice. The last two matter
 * more than they look: without them a system message ends up swallowed inside a
 * rounded block, and the divider lands mid-cluster cutting a bubble group in
 * half. Both read as rendering bugs.
 */
export function buildRows(messages: ChatMessage[], unreadFrom: string | null, viewerId: string): Row[] {
  const rows: Row[] = [];
  let previous: ChatMessage | null = null;
  let dividerPlaced = false;

  for (const message of messages) {
    const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
    if (newDay) {
      rows.push({ kind: "date", key: `date-${message.id}`, label: dayLabel(message.createdAt) });
    }

    // The divider goes before the first message newer than the watermark that
    // this viewer did not send — their own message is never "unread". It may
    // sit directly under a date separator (an overnight unread opens a new
    // day); suppressing it there misplaced the divider onto a later message.
    const isUnreadBoundary =
      !dividerPlaced &&
      unreadFrom !== null &&
      message.createdAt > unreadFrom &&
      message.senderId !== viewerId;
    if (isUnreadBoundary) {
      dividerPlaced = true;
      rows.push({
        kind: "unread",
        key: `unread-${message.id}`,
        count: messages.filter((item) => item.createdAt > unreadFrom && item.senderId !== viewerId).length,
      });
    }

    const notice = message.type === "SYSTEM" || message.type === "CALL";
    const previousNotice = previous ? previous.type === "SYSTEM" || previous.type === "CALL" : true;
    const continuation =
      !newDay &&
      !isUnreadBoundary &&
      !notice &&
      !previousNotice &&
      previous !== null &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUPING_WINDOW_MS;

    rows.push({
      kind: "message",
      key: message.id,
      message,
      showHeader: !continuation,
      isTail: true,
      cluster: continuation ? "last" : "single",
    });

    // The previous row stops being the tail once this one continues it, and its
    // cluster position steps along: single -> first, last -> middle.
    if (continuation) {
      for (let index = rows.length - 2; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (candidate.kind === "message") {
          candidate.isTail = false;
          candidate.cluster = candidate.cluster === "single" ? "first" : "middle";
          break;
        }
      }
    }

    previous = message;
  }

  return rows;
}

export function MessageList({
  messages,
  membersById,
  viewerId,
  pendingByClientId,
  receipts,
  memberCount,
  exitingIds,
  unreadFrom,
  highlightedId,
  selectMode,
  selectedIds,
  onToggleSelect,
  onEnterSelect,
  onForward,
  onJumpToMessage,
  onRetry,
  onDiscard,
}: {
  messages: ChatMessage[];
  membersById: Map<string, ChatMember>;
  viewerId: string;
  pendingByClientId: Map<string, OutgoingMessage>;
  receipts: Record<string, Receipt>;
  memberCount: number;
  exitingIds: ReadonlySet<string>;
  unreadFrom: string | null;
  highlightedId: string | null;
  selectMode: boolean;
  selectedIds: ReadonlySet<string>;
  onToggleSelect: (messageId: string) => void;
  onEnterSelect: (messageId: string) => void;
  onForward: (messageId: string) => void;
  onJumpToMessage: (messageId: string) => void;
  onRetry: (clientMsgId: string) => void;
  onDiscard: (clientMsgId: string) => void;
}) {
  const rows = buildRows(messages, unreadFrom, viewerId);
  // Only the newest row gets the entry animation, and that is what keeps it
  // cheap: prepending 30 older messages during infinite scroll mounts 30 new
  // <li>s, and animating those would be a wave of motion every time the user
  // scrolls up. The last row is already mounted at that moment, so nothing
  // runs. A genuinely new message mounts a new last row, which animates once.
  const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;
  // Quoted previews are resolved against what is loaded. A reply to a message
  // outside the window renders without a quote rather than with a wrong one —
  // tapping it still fetches the anchor page.
  const byId = new Map(messages.map((message) => [message.id, message]));

  return (
    // Not role="log": with aria-relevant="additions", prepending 30 older
    // messages during infinite scroll would announce all thirty. A separate
    // aria-live region in chat-thread announces only the newest arrival.
    <ol aria-label="Messages" className="flex flex-col px-2 py-4 @md/pane:px-3">
      {rows.map((row) => {
        if (row.kind === "date") {
          return (
            // sticky: the day chip pins to the top of the viewport while you
            // scroll through that day, which is how Telegram keeps long
            // scrollback legible. z-10 clears the bubbles beneath it.
            <li key={row.key} className="sticky top-1 z-10 flex justify-center py-2">
              <span className="text-muted-foreground bg-background/80 rounded-full border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur">
                {row.label}
              </span>
            </li>
          );
        }
        if (row.kind === "unread") {
          return (
            <li key={row.key} className="flex items-center gap-2 py-3">
              <span className="bg-primary/30 h-px flex-1" />
              <span className="text-primary text-[11px] font-medium">
                {row.count === 1 ? "1 new message" : `${row.count} new messages`}
              </span>
              <span className="bg-primary/30 h-px flex-1" />
            </li>
          );
        }

        const message = row.message;
        const replyTo = message.replyToId ? byId.get(message.replyToId) : undefined;
        return (
          <MessageBubble
            key={row.key}
            message={message}
            entering={message.id === newestId}
            showHeader={row.showHeader}
            isTail={row.isTail}
            cluster={row.cluster}
            sender={membersById.get(message.senderId)}
            isOwn={message.senderId === viewerId}
            viewerId={viewerId}
            members={membersById}
            status={statusOf(message, pendingByClientId)}
            tick={tickFor(message, viewerId, receipts, memberCount, pendingByClientId)}
            exiting={exitingIds.has(message.id)}
            highlighted={highlightedId === message.id}
            selectMode={selectMode}
            selected={selectedIds.has(message.id)}
            onToggleSelect={() => onToggleSelect(message.id)}
            onEnterSelect={() => onEnterSelect(message.id)}
            onForward={() => onForward(message.id)}
            onJumpToMessage={onJumpToMessage}
            replyPreview={
              message.replyToId
                ? {
                    senderName: replyTo
                      ? replyTo.senderId === viewerId
                        ? "You"
                        : nameOf(membersById.get(replyTo.senderId))
                      : "Message",
                    preview: replyTo ? previewOf(replyTo) : "Original message",
                  }
                : null
            }
            error={message.clientMsgId ? pendingByClientId.get(message.clientMsgId)?.error : undefined}
            onRetry={message.clientMsgId ? () => onRetry(message.clientMsgId!) : undefined}
            onDiscard={message.clientMsgId ? () => onDiscard(message.clientMsgId!) : undefined}
          />
        );
      })}
    </ol>
  );
}

/**
 * Sent / delivered / read, from the two watermarks.
 *
 * A message is delivered-to-X iff X.lastDeliveredAt >= its createdAt, and
 * read-by-X the same way with lastReadAt. That is the whole reason there is no
 * per-message receipt table: two timestamps per member encode the state of
 * every message they will ever receive.
 *
 * In a group the weakest link wins — "read" means everyone has read it, which
 * is the only reading that does not overstate. A member whose privacy hides
 * their presence contributes no receipt at all, so their absence can never
 * upgrade a tick.
 */
function tickFor(
  message: ChatMessage,
  viewerId: string,
  receipts: Record<string, Receipt>,
  memberCount: number,
  pendingByClientId: Map<string, OutgoingMessage>,
): TickState | undefined {
  if (message.senderId !== viewerId) return undefined;
  const status = statusOf(message, pendingByClientId);
  if (status === "pending" || status === "failed") return status;

  const others = Object.entries(receipts).filter(([userId]) => userId !== viewerId);
  // Nobody's watermarks are visible (privacy, or a DM with a hidden partner) —
  // so "sent" is all that can honestly be claimed.
  if (others.length === 0 || others.length < memberCount - 1) return "sent";

  const readByAll = others.every(([, r]) => r.lastReadAt !== null && r.lastReadAt >= message.createdAt);
  if (readByAll) return "read";
  const deliveredToAll = others.every(
    ([, r]) => r.lastDeliveredAt !== null && r.lastDeliveredAt >= message.createdAt,
  );
  return deliveredToAll ? "delivered" : "sent";
}

function statusOf(
  message: ChatMessage,
  pendingByClientId: Map<string, OutgoingMessage>,
): "pending" | "failed" | "sent" | undefined {
  if (!message.clientMsgId) return undefined;
  const pending = pendingByClientId.get(message.clientMsgId);
  if (!pending) return "sent";
  return pending.status === "failed" ? "failed" : "pending";
}

function nameOf(member: ChatMember | undefined): string {
  return member ? `${member.firstName} ${member.lastName ?? ""}`.trim() : "Unknown";
}

function previewOf(message: ChatMessage): string {
  if (message.deletedAt) return "Message deleted";
  switch (message.type) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "FILE":
      return message.mediaName ?? "File";
    default:
      return (message.body ?? "").slice(0, 100);
  }
}

function sameDay(a: string, b: string): boolean {
  const left = new Date(a);
  const right = new Date(b);
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

let dayFormat: Intl.DateTimeFormat | null = null;

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (sameDay(iso, now.toISOString())) return "Today";
  if (sameDay(iso, yesterday.toISOString())) return "Yesterday";

  dayFormat ??= new Intl.DateTimeFormat(undefined, { day: "numeric", month: "long", year: "numeric" });
  return dayFormat.format(date);
}
