import type { ChatMember, ChatMessage } from "@/lib/chat/types";
import type { OutgoingMessage } from "../../../realtime-provider";
import { MessageBubble } from "./message-bubble";

// No "use client": rendered from chat-thread.tsx, inside its boundary.

const GROUPING_WINDOW_MS = 5 * 60 * 1000;

type Row =
  | { kind: "date"; key: string; label: string }
  | { kind: "message"; key: string; message: ChatMessage; showHeader: boolean; isTail: boolean };

/** One walk over the array — grouping and separators are derived, never state. */
export function buildRows(messages: ChatMessage[]): Row[] {
  const rows: Row[] = [];
  let previous: ChatMessage | null = null;

  for (const message of messages) {
    const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);
    if (newDay) {
      rows.push({ kind: "date", key: `date-${message.id}`, label: dayLabel(message.createdAt) });
    }

    const notice = message.type === "SYSTEM" || message.type === "CALL";
    const previousNotice = previous ? previous.type === "SYSTEM" || previous.type === "CALL" : true;
    const continuation =
      !newDay &&
      !notice &&
      !previousNotice &&
      previous !== null &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < GROUPING_WINDOW_MS;

    rows.push({ kind: "message", key: message.id, message, showHeader: !continuation, isTail: true });

    // The previous row stops being the tail once this one continues it.
    if (continuation) {
      for (let index = rows.length - 2; index >= 0; index -= 1) {
        const candidate = rows[index];
        if (candidate.kind === "message") {
          candidate.isTail = false;
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
  onRetry,
  onDiscard,
}: {
  messages: ChatMessage[];
  membersById: Map<string, ChatMember>;
  viewerId: string;
  pendingByClientId: Map<string, OutgoingMessage>;
  onRetry: (clientMsgId: string) => void;
  onDiscard: (clientMsgId: string) => void;
}) {
  const rows = buildRows(messages);

  return (
    // Not role="log": with aria-relevant="additions", prepending 30 older
    // messages during infinite scroll would announce all thirty. A separate
    // aria-live region in chat-thread announces only the newest arrival.
    <ol aria-label="Messages" className="flex flex-col px-3 py-4">
      {rows.map((row) =>
        row.kind === "date" ? (
          <li key={row.key} className="flex justify-center py-3">
            <span className="text-muted-foreground bg-muted/60 rounded-full px-2.5 py-1 text-[11px]">{row.label}</span>
          </li>
        ) : (
          <MessageBubble
            key={row.key}
            message={row.message}
            showHeader={row.showHeader}
            isTail={row.isTail}
            sender={membersById.get(row.message.senderId)}
            isOwn={row.message.senderId === viewerId}
            status={statusOf(row.message, pendingByClientId)}
            error={row.message.clientMsgId ? pendingByClientId.get(row.message.clientMsgId)?.error : undefined}
            onRetry={row.message.clientMsgId ? () => onRetry(row.message.clientMsgId!) : undefined}
            onDiscard={row.message.clientMsgId ? () => onDiscard(row.message.clientMsgId!) : undefined}
          />
        ),
      )}
    </ol>
  );
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
