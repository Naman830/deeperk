import { logServerError } from "@/lib/log";
import type { ChatMessage, ConversationSummary } from "./types";

/**
 * Tells the socket server about something that happened in a Next route.
 *
 * Rooms are joined once, at connect, from a server-side SELECT — so a group you
 * were added to (or removed from) a moment ago reaches you not at all until a
 * reload. chat.md §2.1 joins rooms once and never revisits it. This is the hook
 * that closes that gap.
 *
 * Deliberately a **closed union of event kinds**, not a generic
 * { room, event, payload } RPC: the socket server maps kind → room + event
 * itself, so a leaked INTERNAL_API_SECRET buys only these effects rather than
 * "emit anything to anyone".
 *
 * Always best-effort. The database write is the truth; a failed notification
 * costs the user a refresh, and must never fail their request.
 */
export type InternalEvent =
  | { kind: "conversation.created"; conversationId: string; userIds: string[]; summary?: ConversationSummary }
  | { kind: "members.added"; conversationId: string; userIds: string[]; by: string }
  | { kind: "members.removed"; conversationId: string; userIds: string[]; by: string }
  | { kind: "conversation.updated"; conversationId: string; name?: string | null; avatarUrl?: string | null }
  | { kind: "conversation.read"; conversationId: string; userId: string; lastReadAt: string | null }
  | { kind: "message.created"; conversationId: string; message: ChatMessage }
  // Something changed about ONE member's own view of a conversation — pinned,
  // muted, archived, cleared, hidden. Fans out to that user's other tabs only,
  // never the conversation room: the other members must not learn that you
  // muted or deleted the chat.
  | { kind: "conversation.self-changed"; conversationId: string; userId: string };

export async function notifySocket(event: InternalEvent): Promise<void> {
  const baseUrl = process.env.SOCKET_INTERNAL_URL;
  const secret = process.env.INTERNAL_API_SECRET;
  // Unset locally is fine — chat still works, the other side just finds out on
  // its next reconnect. Silent rather than logged, or every request logs noise.
  if (!baseUrl || !secret) return;

  try {
    const response = await fetch(`${baseUrl}/internal/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": secret },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      logServerError("chat:internal-notify", new Error(`socket server answered ${response.status}`));
    }
  } catch (err) {
    logServerError("chat:internal-notify", err);
  }
}
