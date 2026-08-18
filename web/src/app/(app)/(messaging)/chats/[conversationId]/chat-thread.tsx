"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { Button } from "@/components/ui/button";
import {
  subscribeLive,
  getLiveMessages,
  getServerLiveMessages,
  mergeMessages,
  pushLiveMessages,
} from "@/lib/chat/live-store";
import { useStickToBottom } from "@/lib/hooks/use-stick-to-bottom";
import { formatMessageCursor } from "@/lib/validation/chat";
import type { ChatMessage, ConversationDetail } from "@/lib/chat/types";
import { useRealtime } from "../../../realtime-provider";
import { ThreadHeader } from "./thread-header";
import { MessageList } from "./message-list";
import { MessageComposer } from "./message-composer";
import { TypingIndicator } from "./typing-indicator";

/**
 * The only "use client" boundary in this subtree — everything below it is
 * directive-free and inherits this one.
 */
export function ChatThread({
  viewerId,
  conversation,
  initialMessages,
  initialCursor,
  initialHasMore,
}: {
  viewerId: string;
  conversation: ConversationDetail;
  initialMessages: ChatMessage[];
  initialCursor: string | null;
  initialHasMore: boolean;
}) {
  const { connection, presence, typingIn, markRead, outboxFor, retryMessage, discardMessage } = useRealtime();

  const [history, setHistory] = useState(initialMessages);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const loadingOlderRef = useRef(false);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // useSyncExternalStore, not useState: a lazy initializer would differ between
  // the SSR render (buffer empty) and the first client render (buffer possibly
  // not), and merging in an effect is a setState-in-effect. getServerSnapshot
  // returns the same frozen array every time, which is what stops React's
  // "getSnapshot should be cached" loop.
  const live = useSyncExternalStore(
    subscribeLive,
    () => getLiveMessages(conversation.id),
    getServerLiveMessages,
  );

  const messages = useMemo(() => mergeMessages(history, live), [history, live]);
  const { scrollRef, onScroll, isPinned, stickToBottom, captureBeforePrepend } = useStickToBottom(
    conversation.id,
    messages.length,
  );

  const membersById = useMemo(
    () => new Map(conversation.members.map((member) => [member.id, member])),
    [conversation.members],
  );
  const other = useMemo(
    () => conversation.members.find((member) => member.id !== viewerId),
    [conversation.members, viewerId],
  );

  const pendingByClientId = useMemo(
    () => new Map(outboxFor(conversation.id).map((entry) => [entry.clientMsgId, entry])),
    [outboxFor, conversation.id],
  );

  // Optimistic bubbles the server hasn't echoed yet. Always sorted last: they
  // carry the client clock, and a slow client would otherwise place its own
  // message before ones it already received.
  const pendingOnly = useMemo(() => {
    const known = new Set(messages.map((message) => message.clientMsgId).filter(Boolean));
    return outboxFor(conversation.id)
      .filter((entry) => !known.has(entry.clientMsgId))
      .map(
        (entry): ChatMessage => ({
          id: `pending:${entry.clientMsgId}`,
          conversationId: entry.conversationId,
          senderId: viewerId,
          type: entry.type,
          body: entry.body,
          mediaUrl: entry.mediaUrl,
          mediaMime: entry.mediaMime,
          mediaSize: entry.mediaSize,
          mediaName: entry.mediaName,
          callId: null,
          clientMsgId: entry.clientMsgId,
          createdAt: entry.createdAt,
          deletedAt: null,
        }),
      );
  }, [messages, outboxFor, conversation.id, viewerId]);

  const rendered = useMemo(() => [...messages, ...pendingOnly], [messages, pendingOnly]);

  // Mark read on mount and whenever the newest message changes while focused.
  const newestId = rendered.length > 0 ? rendered[rendered.length - 1].id : null;
  useEffect(() => {
    if (document.visibilityState === "visible" && document.hasFocus()) markRead(conversation.id);
  }, [conversation.id, newestId, markRead]);

  // Backfill anything sent while this tab was disconnected. Socket.IO
  // reconnection starts a fresh session with no replay, so without this the gap
  // is lost silently. A ref, not a closure over messages: the cursor must be
  // the newest message at backfill time, not at effect-registration time.
  const newestRef = useRef<ChatMessage | null>(null);
  useEffect(() => {
    newestRef.current = messages.length > 0 ? messages[messages.length - 1] : null;
  }, [messages]);

  const backfill = useCallback(async () => {
    const newest = newestRef.current;
    if (!newest) return;
    const after = formatMessageCursor(new Date(newest.createdAt), newest.id);
    try {
      const response = await fetch(
        `/api/conversations/${conversation.id}/messages?after=${encodeURIComponent(after)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages: ChatMessage[] };
      if (data.messages?.length) pushLiveMessages(data.messages);
    } catch {
      // Next reconnect will retry.
    }
  }, [conversation.id]);

  useEffect(() => {
    window.addEventListener("online", backfill);
    return () => window.removeEventListener("online", backfill);
  }, [backfill]);

  // The socket half of the same gap: a reconnect with no network transition
  // (server restart, proxy drop) never fires the browser "online" event.
  useEffect(() => {
    if (connection === "online") void backfill();
  }, [connection, backfill]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMore || !cursor) return;
    loadingOlderRef.current = true;
    try {
      const response = await fetch(
        `/api/conversations/${conversation.id}/messages?before=${encodeURIComponent(cursor)}`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as { messages: ChatMessage[]; nextCursor: string | null; hasMore: boolean };
      // Captured synchronously before the state change, so the layout effect can
      // restore the exact reading position from the scrollHeight delta.
      captureBeforePrepend();
      setHistory((current) => [...data.messages, ...current]);
      setCursor(data.nextCursor);
      setHasMore(data.hasMore);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [conversation.id, cursor, hasMore, captureBeforePrepend]);

  // Keyed on [id, hasMore] only — including `messages` would tear down and
  // rebuild the observer on every incoming message.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) void loadOlder();
      },
      { root, rootMargin: "300px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [conversation.id, hasMore, loadOlder, scrollRef]);

  // Desktop: focus the composer. Mobile: focusing it yanks the keyboard up and
  // hides the message the user navigated to see, so focus the heading instead —
  // which also stops a screen-reader user being left on the list row they tapped.
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px) and (pointer: fine)").matches;
    if (!desktop) headingRef.current?.focus();
  }, [conversation.id]);

  const typingNames = typingIn(conversation.id);
  const newest = rendered[rendered.length - 1];
  const announcement =
    newest && newest.senderId !== viewerId
      ? `${membersById.get(newest.senderId)?.firstName ?? "Someone"}: ${newest.body ?? ""}`
      : "";

  return (
    <MainPane className="@container/pane">
      <ThreadHeader
        conversation={conversation}
        other={other}
        presenceOnline={other ? presence[other.id]?.isOnline : undefined}
        headingRef={headingRef}
        viewerId={viewerId}
      />

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scroll-thin absolute inset-0 overflow-y-auto overscroll-contain">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          <MessageList
            messages={rendered}
            membersById={membersById}
            viewerId={viewerId}
            pendingByClientId={pendingByClientId}
            onRetry={retryMessage}
            onDiscard={discardMessage}
          />
          <TypingIndicator names={typingNames} />
        </div>

        {!isPinned && (
          <Button
            size="sm"
            onClick={stickToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 shadow-md"
          >
            <ArrowDown /> Latest
          </Button>
        )}
      </div>

      {/* Announces only the newest incoming message, never a bulk prepend. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      <MessageComposer conversationId={conversation.id} />
    </MainPane>
  );
}
