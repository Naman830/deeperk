"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "react-toastify";
import { ArrowDown } from "lucide-react";
import { MainPane } from "@/components/features/shell/main-pane";
import { Button } from "@/components/ui/button";
import { JoinCallBanner } from "@/components/features/call/join-call-banner";
import {
  subscribeLive,
  getLiveMessages,
  getServerLiveMessages,
  getExitingIds,
  getServerExitingIds,
  mergeMessages,
  pushLiveMessages,
} from "@/lib/chat/live-store";
import { copyText } from "@/lib/clipboard";
import { useStickToBottom } from "@/lib/hooks/use-stick-to-bottom";
import { formatMessageCursor } from "@/lib/validation/chat";
import type { ChatMessage, ConversationDetail } from "@/lib/chat/types";
import { useRealtime } from "../../../realtime-provider";
import { ThreadHeader } from "./thread-header";
import { SelectionBar } from "./selection-bar";
import { MessageList } from "./message-list";
import { MessageComposer } from "./message-composer";
import { TypingIndicator } from "./typing-indicator";
import { ThreadSearch } from "./thread-search";
import { MediaPanel } from "./media-panel";
import { ForwardDialog } from "./forward-dialog";
import { DeleteMessageDialog } from "./delete-message-dialog";

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
  const router = useRouter();
  const {
    connection,
    presence,
    typingIn,
    markRead,
    outboxFor,
    retryMessage,
    discardMessage,
    deleteMessage,
    setReply,
    setEdit,
    receiptsFor,
    seedReceipts,
  } = useRealtime();

  const [history, setHistory] = useState(initialMessages);
  const [cursor, setCursor] = useState(initialCursor);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [searchOpen, setSearchOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [selectMode, setSelectMode] = useState(false);
  const [forwarding, setForwarding] = useState<string[] | null>(null);
  const [confirmingBulkDelete, setConfirmingBulkDelete] = useState(false);
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
  const exitingIds = useSyncExternalStore(
    subscribeLive,
    () => getExitingIds(conversation.id),
    getServerExitingIds,
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

  /**
   * The unread watermark, captured ONCE on mount into a ref.
   *
   * Reading conversation.lastReadAt live would make the divider vanish the
   * instant markRead fires — which is immediately — so the user would never see
   * it. This is the one piece of state here that must deliberately go stale.
   */
  const [unreadFrom] = useState<string | null>(() => {
    const watermark = conversation.lastReadAt;
    if (!watermark) return null;
    // Only worth a divider if something actually arrived after it from someone
    // else. A divider above your own last message reads as a bug.
    const has = initialMessages.some((item) => item.createdAt > watermark && item.senderId !== viewerId);
    return has ? watermark : null;
  });

  // An effect rather than a render-time call: it writes to module-level state,
  // and a render-phase write is a side effect React is allowed to run twice.
  useEffect(() => {
    seedReceipts(conversation.id, conversation.members);
  }, [conversation.id, conversation.members, seedReceipts]);

  /**
   * Selection must never survive a conversation switch — carrying one into
   * another chat and hitting Delete is not undoable.
   *
   * Adjusted DURING RENDER against a remembered id rather than in an effect.
   * React documents this as the way to reset state when a prop changes, and it
   * is the only version that is correct here: an effect would render one frame
   * of the new conversation with the old conversation's selection still
   * highlighted, and it trips React 19's set-state-in-effect rule.
   */
  const [renderedConversationId, setRenderedConversationId] = useState(conversation.id);
  if (renderedConversationId !== conversation.id) {
    setRenderedConversationId(conversation.id);
    setSelectMode(false);
    setSelectedIds(EMPTY_SET);
    setSearchOpen(false);
    setHighlightedId(null);
  }

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
          mediaWidth: null,
          mediaHeight: null,
          mediaDurationMs: entry.mediaDurationMs ?? null,
          callId: null,
          clientMsgId: entry.clientMsgId,
          replyToId: entry.replyToId ?? null,
          createdAt: entry.createdAt,
          editedAt: null,
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
      const data = (await response.json()) as {
        messages: ChatMessage[];
        nextCursor: string | null;
        hasMore: boolean;
      };
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

  /**
   * Scroll to a message, fetching the page around it if it isn't loaded.
   *
   * Used by a reply's quoted snippet and by a search or media result, both of
   * which can target something hundreds of rows outside the window. The
   * ?around= page REPLACES history rather than merging into it: the anchor may
   * be far older than anything loaded, and stitching two disjoint ranges
   * together would render a thread with an invisible hole in the middle.
   */
  const jumpToMessage = useCallback(
    async (messageId: string) => {
      const flash = () => {
        setHighlightedId(messageId);
        // requestAnimationFrame, so the element exists in the DOM after a
        // history replacement before we try to find it.
        requestAnimationFrame(() => {
          const node = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
          node?.scrollIntoView({ block: "center", behavior: "smooth" });
        });
        window.setTimeout(() => setHighlightedId((current) => (current === messageId ? null : current)), 2000);
      };

      if (rendered.some((item) => item.id === messageId)) {
        flash();
        return;
      }

      // Not loaded — the cursor needs the message's own timestamp, which we do
      // not have, so ask the server for the id directly.
      try {
        const response = await fetch(
          `/api/conversations/${conversation.id}/messages?aroundId=${encodeURIComponent(messageId)}`,
        );
        if (!response.ok) {
          toast.error("Couldn't find that message");
          return;
        }
        const data = (await response.json()) as {
          messages: ChatMessage[];
          nextCursor: string | null;
          hasMore: boolean;
        };
        setHistory(data.messages);
        setCursor(data.nextCursor);
        setHasMore(data.hasMore);
        flash();
      } catch {
        toast.error("Couldn't find that message");
      }
    },
    [conversation.id, rendered],
  );

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

  // Esc closes the thread, but only where there is something to close: below md
  // the conversation column is hidden and this pane is the whole screen, so Esc
  // is the keyboard twin of the back arrow. At md+ both columns are visible and
  // Esc must do nothing.
  //
  // The breakpoint is read inside the handler, never during render — a boolean
  // derived from matchMedia at render time is a hydration mismatch, which is the
  // shape this repo has already been bitten by. Same idiom as the focus effect
  // above.
  //
  // push("/chats"), not router.back(): a thread can be reached from a deep link,
  // a toast, /search or a profile's Message button, so back() variously exits the
  // app or lands on a profile. push matches exactly what the back arrow's
  // <Link href="/chats"> already does, so the two agree and browser history stays
  // as it is today.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Radix stops propagation for its own overlays, so an open menu or dialog
      // has already consumed this. A composer with text in it has not, and
      // closing the thread out from under a half-typed message would be rude.
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable=true]")) return;
      // Selection and search are shallower states — Esc backs out of those
      // first, exactly as it backs out of a dialog before the page behind it.
      if (selectMode) {
        setSelectMode(false);
        setSelectedIds(EMPTY_SET);
        return;
      }
      if (searchOpen) {
        setSearchOpen(false);
        return;
      }
      if (window.matchMedia("(min-width: 768px)").matches) return;
      router.push("/chats");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // Re-registered when either flag changes, rather than read through refs.
    // Two booleans make this cheap, and the ref version is what React 19's
    // immutability rule rejects.
  }, [router, selectMode, searchOpen]);

  const toggleSelect = useCallback((messageId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(messageId)) next.delete(messageId);
      else next.add(messageId);
      return next;
    });
  }, []);

  const enterSelect = useCallback((messageId: string) => {
    setSelectMode(true);
    setSelectedIds(new Set([messageId]));
  }, []);

  const exitSelect = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(EMPTY_SET);
  }, []);

  const forwardOne = useCallback((messageId: string) => {
    setForwarding([messageId]);
  }, []);

  const copySelected = useCallback(async () => {
    const chosen = rendered.filter((item) => selectedIds.has(item.id) && item.type === "TEXT");
    const text = chosen.map((item) => item.body ?? "").join("\n\n");
    const ok = await copyText(text);
    toast[ok ? "success" : "error"](ok ? "Copied" : "Nothing to copy");
    exitSelect();
  }, [rendered, selectedIds, exitSelect]);

  const deleteSelected = useCallback(
    async (scope: "me" | "everyone") => {
      const failure = await deleteMessage([...selectedIds], scope);
      if (failure) toast.error(failure);
      exitSelect();
      return failure;
    },
    [deleteMessage, selectedIds, exitSelect],
  );

  // Every selected message is your own and still live — the only case where
  // "delete for everyone" can be offered for the whole set.
  const canBulkDeleteForEveryone = useMemo(
    () =>
      selectedIds.size > 0 &&
      rendered
        .filter((item) => selectedIds.has(item.id))
        .every((item) => item.senderId === viewerId && item.deletedAt === null),
    [rendered, selectedIds, viewerId],
  );

  const typingNames = typingIn(conversation.id);
  const newest = rendered[rendered.length - 1];
  const announcement =
    newest && newest.senderId !== viewerId
      ? `${membersById.get(newest.senderId)?.firstName ?? "Someone"}: ${newest.body ?? ""}`
      : "";

  return (
    <MainPane className="@container/pane">
      {selectMode ? (
        <SelectionBar
          count={selectedIds.size}
          onCopy={() => void copySelected()}
          onForward={() => setForwarding([...selectedIds])}
          onDelete={() => setConfirmingBulkDelete(true)}
          onCancel={exitSelect}
        />
      ) : (
        <ThreadHeader
          conversation={conversation}
          other={other}
          presenceOnline={other ? presence[other.id]?.isOnline : undefined}
          typingNames={typingNames}
          headingRef={headingRef}
          viewerId={viewerId}
          onOpenSearch={() => setSearchOpen(true)}
          onOpenMedia={() => setMediaOpen(true)}
        />
      )}

      {conversation.type === "GROUP" && <JoinCallBanner conversationId={conversation.id} />}

      {searchOpen && !selectMode && (
        <ThreadSearch
          conversationId={conversation.id}
          membersById={membersById}
          viewerId={viewerId}
          onJump={(messageId) => {
            setSearchOpen(false);
            void jumpToMessage(messageId);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="scroll-thin absolute inset-0 overflow-y-auto overscroll-contain">
          <div ref={sentinelRef} aria-hidden className="h-px" />
          <MessageList
            messages={rendered}
            membersById={membersById}
            viewerId={viewerId}
            pendingByClientId={pendingByClientId}
            receipts={receiptsFor(conversation.id)}
            memberCount={conversation.members.length}
            exitingIds={exitingIds}
            unreadFrom={unreadFrom}
            highlightedId={highlightedId}
            selectMode={selectMode}
            selectedIds={selectedIds}
            deleteMessage={deleteMessage}
            setReply={setReply}
            setEdit={setEdit}
            onToggleSelect={toggleSelect}
            onEnterSelect={enterSelect}
            onForward={forwardOne}
            onJumpToMessage={jumpToMessage}
            onRetry={retryMessage}
            onDiscard={discardMessage}
          />
          <TypingIndicator names={typingNames} />
        </div>

        {!isPinned && (
          <Button
            size="sm"
            onClick={stickToBottom}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-lg"
          >
            <ArrowDown /> Latest
          </Button>
        )}
      </div>

      {/* Announces only the newest incoming message, never a bulk prepend. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {/* Hidden, not unmounted: unmounting would silently discard a live
          recording, a pending voice take, and the reply/edit strips. */}
      <MessageComposer
        conversationId={conversation.id}
        members={conversation.members}
        isGroup={conversation.type === "GROUP"}
        hidden={selectMode}
      />

      <ForwardDialog
        open={forwarding !== null}
        onOpenChange={(open) => !open && setForwarding(null)}
        messageIds={forwarding ?? []}
        fromConversationId={conversation.id}
        onDone={exitSelect}
      />

      <MediaPanel
        open={mediaOpen}
        onOpenChange={setMediaOpen}
        conversationId={conversation.id}
        onJump={(messageId) => void jumpToMessage(messageId)}
      />

      <DeleteMessageDialog
        open={confirmingBulkDelete}
        onOpenChange={setConfirmingBulkDelete}
        canDeleteForEveryone={canBulkDeleteForEveryone}
        count={selectedIds.size}
        onConfirm={deleteSelected}
      />
    </MainPane>
  );
}

// One shared empty Set, so clearing the selection returns the same reference
// rather than a fresh object that would invalidate every memo downstream.
const EMPTY_SET: ReadonlySet<string> = new Set<string>();
