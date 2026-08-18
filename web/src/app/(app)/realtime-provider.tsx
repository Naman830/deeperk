"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { acquireSocket, releaseSocket, type ChatSocket } from "@/lib/realtime/socket";
import { primeBlip, playBlip, resumeBlip } from "@/lib/realtime/blip";
import { startBlink, stopBlink, forgetBlinkBase } from "@/lib/realtime/title-blink";
import {
  pushLiveMessage,
  pushLiveMessages,
  markLiveMessageDeleted,
  clearLiveMessages,
} from "@/lib/chat/live-store";
import type { ChatMessage, ConversationSummary } from "@/lib/chat/types";
import { notifyIncomingMessage, notifyAddedToConversation } from "./message-toast";

/**
 * The single realtime connection, and every piece of state that must outlive a
 * route change.
 *
 * Mounted at (app), not (messaging), for three independent reasons:
 *   1. Without Cache Components, <Activity> state preservation is off, so
 *      /chats/[id] genuinely unmounts on every conversation switch — a socket
 *      owned by the page would die each time.
 *   2. The global unread badge lives on AppRail, a *sibling* of {children} and
 *      not a descendant of (messaging)/layout.tsx.
 *   3. Toasts, the title blink and the sound must fire while the user is in
 *      /settings or /calls.
 *
 * The outbox and drafts live here for reason (1) too: a half-typed message
 * survives clicking a search result, and an in-flight send survives navigating
 * away mid-send.
 */

export type SendStatus = "uploading" | "pending" | "failed";

export type OutgoingMessage = {
  clientMsgId: string;
  conversationId: string;
  type: "TEXT" | "IMAGE" | "VIDEO" | "FILE";
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaSize: number | null;
  mediaName: string | null;
  mediaToken?: string;
  createdAt: string;
  status: SendStatus;
  progress?: number;
  error?: string;
};

type PresenceEntry = { isOnline: boolean; lastSeenAt: string | null };
type TypingEntry = { username: string; expiresAt: number };

type RealtimeValue = {
  viewerId: string;
  connection: "connecting" | "online" | "offline";
  conversations: ConversationSummary[];
  unreadTotal: number;
  presence: Record<string, PresenceEntry>;
  typingIn: (conversationId: string) => string[];
  outboxFor: (conversationId: string) => OutgoingMessage[];
  draftFor: (conversationId: string) => string;
  setDraft: (conversationId: string, value: string) => void;
  sendMessage: (input: Omit<OutgoingMessage, "createdAt" | "status">) => void;
  retryMessage: (clientMsgId: string) => void;
  discardMessage: (clientMsgId: string) => void;
  deleteMessage: (messageId: string) => Promise<string | null>;
  markRead: (conversationId: string) => void;
  emitTyping: (conversationId: string, typing: boolean) => void;
  refreshConversations: () => Promise<void>;
};

const RealtimeContext = createContext<RealtimeValue | null>(null);

export function useRealtime(): RealtimeValue {
  const value = useContext(RealtimeContext);
  if (!value) throw new Error("useRealtime must be used inside <RealtimeProvider>");
  return value;
}

const SEND_TIMEOUT_MS = 10_000;
const TYPING_TTL_MS = 5000;

export function RealtimeProvider({
  viewerId,
  initialConversations,
  children,
}: {
  viewerId: string;
  initialConversations: ConversationSummary[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();

  // Derived during render: no setState, no effect, no ordering hazard — and
  // already correct before the thread component mounts, which matters because
  // a message can arrive in that window and must not be toasted.
  const activeConversationId = pathname.startsWith("/chats/")
    ? pathname.slice("/chats/".length).split("/")[0] || null
    : null;

  const [connection, setConnection] = useState<RealtimeValue["connection"]>("connecting");
  // Seeded from the server, then owned by the socket. router.refresh() will
  // re-run the layout query but useState ignores the new prop — that is
  // intentional; the real resync is refreshConversations() on every connect.
  const [conversations, setConversations] = useState(initialConversations);
  const [presence, setPresence] = useState<Record<string, PresenceEntry>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, TypingEntry>>>({});
  const [outbox, setOutbox] = useState<Record<string, OutgoingMessage>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const socketRef = useRef<ChatSocket | null>(null);
  // Handlers read this instead of closing over props, so the listener set is
  // registered once rather than rebuilt on every render. Writing a ref inside
  // an effect body is not a setState and doesn't trip the React 19 lint rule.
  const stateRef = useRef({ viewerId, activeConversationId, conversations });
  useEffect(() => {
    stateRef.current = { viewerId, activeConversationId, conversations };
  });

  const refreshConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations");
      if (!response.ok) return;
      const data = (await response.json()) as { conversations: ConversationSummary[] };
      setConversations(data.conversations ?? []);
    } catch {
      // Offline; the next reconnect will retry.
    }
  }, []);

  const markRead = useCallback((conversationId: string) => {
    socketRef.current?.emit("conversation:read", { conversationId });
    setConversations((current) =>
      current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)),
    );
  }, []);

  // Declared above the socket effect because the effect's handlers call it:
  // the React Compiler treats a later declaration as a use-before-declare and
  // refuses to preserve the memoization.
  const confirmOutgoing = useCallback((clientMsgId: string) => {
    setOutbox((current) => {
      if (!current[clientMsgId]) return current;
      const next = { ...current };
      delete next[clientMsgId];
      return next;
    });
  }, []);

  // --- socket lifecycle ------------------------------------------------
  useEffect(() => {
    const socket = acquireSocket();
    socketRef.current = socket;

    const onConnect = () => {
      setConnection("online");
      // Resync on EVERY connect, not just the first: this is the half of "no
      // missing messages" that covers whatever was sent while we were down.
      void refreshConversations();
      const active = stateRef.current.activeConversationId;
      if (active) socket.emit("conversation:read", { conversationId: active });
    };

    const onDisconnect = (reason: string) => {
      if (reason !== "io client disconnect") setConnection("offline");
    };

    const onConnectError = (err: Error & { data?: { code?: string } }) => {
      setConnection("offline");
      // Never retry an auth rejection — that is a hot loop against a 401.
      if (err.data?.code === "UNAUTHENTICATED") {
        socket.disconnect();
        router.replace("/login");
      }
    };

    const onMessageNew = ({ message }: { conversationId: string; message: ChatMessage }) => {
      pushLiveMessage(message);
      applyIncoming(message);
    };

    const onMessageDeleted = ({
      conversationId,
      messageId,
      deletedAt,
    }: {
      conversationId: string;
      messageId: string;
      deletedAt: string;
    }) => {
      markLiveMessageDeleted(conversationId, messageId, deletedAt);
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId && item.lastMessage?.id === messageId
            ? { ...item, lastMessage: { ...item.lastMessage, preview: "This message was deleted", deletedAt } }
            : item,
        ),
      );
    };

    const onPresenceOnline = ({ userId }: { userId: string }) => {
      setPresence((current) => ({ ...current, [userId]: { isOnline: true, lastSeenAt: null } }));
    };

    const onPresenceOffline = ({ userId, lastSeenAt }: { userId: string; lastSeenAt: string | null }) => {
      setPresence((current) => ({ ...current, [userId]: { isOnline: false, lastSeenAt: lastSeenAt ?? null } }));
    };

    const onTypingStart = ({
      conversationId,
      userId,
      username,
    }: {
      conversationId: string;
      userId: string;
      username: string;
    }) => {
      setTyping((current) => ({
        ...current,
        [conversationId]: { ...current[conversationId], [userId]: { username, expiresAt: Date.now() + TYPING_TTL_MS } },
      }));
    };

    const onTypingStop = ({ conversationId, userId }: { conversationId: string; userId: string }) => {
      setTyping((current) => {
        const room = current[conversationId];
        if (!room || !room[userId]) return current;
        const next = { ...room };
        delete next[userId];
        return { ...current, [conversationId]: next };
      });
    };

    const onConversationChanged = () => {
      void refreshConversations();
    };

    const onConversationAdded = ({ conversationId }: { conversationId: string }) => {
      void refreshConversations();
      notifyAddedToConversation({ conversationId, title: "You were added to a conversation" });
    };

    const onReadSync = ({ conversationId }: { conversationId: string }) => {
      setConversations((current) =>
        current.map((item) => (item.id === conversationId ? { ...item, unreadCount: 0 } : item)),
      );
    };

    function applyIncoming(message: ChatMessage) {
      const { viewerId: me, activeConversationId: active } = stateRef.current;
      const mine = message.senderId === me;
      // document.hasFocus() is the clause usually missed: a tab can be
      // `visible` inside a window that isn't focused, and clearing the badge
      // then would mark messages read that nobody saw.
      const isViewing =
        active === message.conversationId &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible" &&
        document.hasFocus();

      // A conversation we don't know about yet (just added to a group) —
      // refetch rather than drop it. Checked against stateRef out here rather
      // than inside the updater: updaters must stay pure (StrictMode
      // double-invokes them), so no fetch may start from within one.
      if (!stateRef.current.conversations.some((item) => item.id === message.conversationId)) {
        void refreshConversations();
      }

      setConversations((current) => {
        const index = current.findIndex((item) => item.id === message.conversationId);
        if (index === -1) return current;
        const updated: ConversationSummary = {
          ...current[index],
          updatedAt: message.createdAt,
          unreadCount: mine || isViewing ? 0 : current[index].unreadCount + 1,
          lastMessage: {
            id: message.id,
            senderId: message.senderId,
            type: message.type,
            preview: previewOf(message),
            createdAt: message.createdAt,
            deletedAt: message.deletedAt,
          },
        };
        return [updated, ...current.slice(0, index), ...current.slice(index + 1)];
      });

      // Confirmed by the broadcast as well as by the ack — whichever lands
      // first wins, the other is a no-op.
      if (message.clientMsgId) confirmOutgoing(message.clientMsgId);

      if (mine || isViewing) {
        if (isViewing) markRead(message.conversationId);
        return;
      }

      const conversation = stateRef.current.conversations.find((item) => item.id === message.conversationId);
      notifyIncomingMessage({
        conversationId: message.conversationId,
        title: conversationTitle(conversation),
        preview: previewOf(message),
        onOpen: () => router.push(`/chats/${message.conversationId}`),
      });
      playBlip();
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        startBlink(unreadTotalOf(stateRef.current.conversations) + 1);
      }
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("message:new", onMessageNew);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("presence:online", onPresenceOnline);
    socket.on("presence:offline", onPresenceOffline);
    socket.on("typing:start", onTypingStart);
    socket.on("typing:stop", onTypingStop);
    socket.on("conversation:added", onConversationAdded);
    socket.on("conversation:removed", onConversationChanged);
    socket.on("conversation:updated", onConversationChanged);
    socket.on("conversation:read-sync", onReadSync);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("message:new", onMessageNew);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("presence:online", onPresenceOnline);
      socket.off("presence:offline", onPresenceOffline);
      socket.off("typing:start", onTypingStart);
      socket.off("typing:stop", onTypingStop);
      socket.off("conversation:added", onConversationAdded);
      socket.off("conversation:removed", onConversationChanged);
      socket.off("conversation:updated", onConversationChanged);
      socket.off("conversation:read-sync", onReadSync);
      releaseSocket();
    };
    // Empty deps on purpose: every handler reads stateRef, so re-registering
    // them on each render would tear down and rebuild the listener set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A dropped typing:stop (the other side disconnected mid-keystroke) would
  // otherwise leave "X is typing…" on screen forever.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTyping((current) => {
        let changed = false;
        const next: typeof current = {};
        for (const [conversationId, room] of Object.entries(current)) {
          const live = Object.fromEntries(Object.entries(room).filter(([, entry]) => entry.expiresAt > now));
          if (Object.keys(live).length !== Object.keys(room).length) changed = true;
          next[conversationId] = live;
        }
        return changed ? next : current;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  // Audio can only be unlocked from a real gesture, and on iOS the context must
  // be constructed during one — hence `once` listeners rather than a call at mount.
  useEffect(() => {
    const prime = () => primeBlip();
    document.addEventListener("pointerdown", prime, { once: true, capture: true, passive: true });
    document.addEventListener("keydown", prime, { once: true, capture: true });
    return () => {
      document.removeEventListener("pointerdown", prime, { capture: true });
      document.removeEventListener("keydown", prime, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      stopBlink();
      resumeBlip();
      const active = stateRef.current.activeConversationId;
      if (active) markRead(active);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [markRead]);

  // Next rewrites document.title on every navigation, so a blink running across
  // one would capture a stale base and restore the wrong title permanently.
  useEffect(() => {
    forgetBlinkBase();
  }, [pathname]);

  // --- sending ---------------------------------------------------------
  const dispatchSend = useCallback(
    (entry: OutgoingMessage) => {
      const socket = socketRef.current;
      if (!socket) return;
      setOutbox((current) => ({ ...current, [entry.clientMsgId]: { ...entry, status: "pending", error: undefined } }));

      // A bare emit() on a dead socket buffers silently and the bubble spins
      // forever. The ack timeout is what turns that into a definite failure the
      // user can retry — chat.md §8's "no silent message loss".
      socket
        .timeout(SEND_TIMEOUT_MS)
        .emit(
          "message:send",
          {
            conversationId: entry.conversationId,
            clientMsgId: entry.clientMsgId,
            type: entry.type,
            text: entry.body ?? undefined,
            mediaToken: entry.mediaToken,
          },
          (timeoutError: Error | null, response?: { ok: boolean; error?: string; message?: ChatMessage }) => {
            if (timeoutError || !response?.ok) {
              setOutbox((current) => {
                const existing = current[entry.clientMsgId];
                if (!existing) return current;
                return {
                  ...current,
                  [entry.clientMsgId]: { ...existing, status: "failed", error: response?.error ?? "Not sent" },
                };
              });
              return;
            }
            if (response.message) pushLiveMessage(response.message);
            confirmOutgoing(entry.clientMsgId);
          },
        );
    },
    [confirmOutgoing],
  );

  const sendMessage = useCallback<RealtimeValue["sendMessage"]>(
    (input) => {
      dispatchSend({ ...input, createdAt: new Date().toISOString(), status: "pending" });
    },
    [dispatchSend],
  );

  const retryMessage = useCallback(
    (clientMsgId: string) => {
      const entry = outbox[clientMsgId];
      // Same clientMsgId, never a fresh one: the server's unique index on
      // (senderId, clientMsgId) is what stops a buffered original and a retry
      // both landing.
      if (entry) dispatchSend(entry);
    },
    [outbox, dispatchSend],
  );

  const discardMessage = useCallback((clientMsgId: string) => {
    setOutbox((current) => {
      const next = { ...current };
      delete next[clientMsgId];
      return next;
    });
  }, []);

  const deleteMessage = useCallback(async (messageId: string): Promise<string | null> => {
    const socket = socketRef.current;
    if (!socket) return "You're offline";
    return new Promise((resolve) => {
      socket
        .timeout(SEND_TIMEOUT_MS)
        .emit("message:delete", { messageId }, (timeoutError: Error | null, response?: { ok: boolean; error?: string }) => {
          if (timeoutError || !response?.ok) resolve(response?.error ?? "Couldn't delete that");
          else resolve(null);
        });
    });
  }, []);

  const emitTyping = useCallback((conversationId: string, isTyping: boolean) => {
    socketRef.current?.emit(isTyping ? "typing:start" : "typing:stop", { conversationId });
  }, []);

  const setDraft = useCallback((conversationId: string, value: string) => {
    setDrafts((current) => ({ ...current, [conversationId]: value }));
  }, []);

  useEffect(() => {
    return () => clearLiveMessages();
  }, []);

  const unreadTotal = useMemo(() => unreadTotalOf(conversations), [conversations]);

  const value = useMemo<RealtimeValue>(
    () => ({
      viewerId,
      connection,
      conversations,
      unreadTotal,
      presence,
      // The server relays typing to every socket in the room except the sender's
      // own — which includes the sender's *other tabs*, so filter self here or a
      // second tab shows "you are typing".
      typingIn: (conversationId) =>
        Object.entries(typing[conversationId] ?? {})
          .filter(([userId]) => userId !== viewerId)
          .map(([, entry]) => entry.username),
      outboxFor: (conversationId) =>
        Object.values(outbox).filter((entry) => entry.conversationId === conversationId),
      draftFor: (conversationId) => drafts[conversationId] ?? "",
      setDraft,
      sendMessage,
      retryMessage,
      discardMessage,
      deleteMessage,
      markRead,
      emitTyping,
      refreshConversations,
    }),
    [
      viewerId,
      connection,
      conversations,
      unreadTotal,
      presence,
      typing,
      outbox,
      drafts,
      setDraft,
      sendMessage,
      retryMessage,
      discardMessage,
      deleteMessage,
      markRead,
      emitTyping,
      refreshConversations,
    ],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function unreadTotalOf(conversations: ConversationSummary[]): number {
  return conversations.reduce((total, item) => total + item.unreadCount, 0);
}

function conversationTitle(conversation: ConversationSummary | undefined): string {
  if (!conversation) return "New message";
  if (conversation.type === "GROUP") return conversation.name ?? "Group";
  const other = conversation.otherUser;
  if (!other) return "New message";
  return `${other.firstName} ${other.lastName ?? ""}`.trim();
}

function previewOf(message: ChatMessage): string {
  if (message.deletedAt) return "This message was deleted";
  switch (message.type) {
    case "IMAGE":
      return "Photo";
    case "VIDEO":
      return "Video";
    case "FILE":
      return message.mediaName ?? "File";
    case "CALL":
      return "Call";
    default:
      return (message.body ?? "").slice(0, 120);
  }
}

// Re-exported so the thread can backfill after a reconnect without importing
// the store directly from two places.
export { pushLiveMessages };
