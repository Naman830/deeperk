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
  markLiveMessageHidden,
  markLiveMessageEdited,
  clearLiveMessages,
} from "@/lib/chat/live-store";
import { mentionsUser } from "@/lib/chat/rich-text";
import { callPreviewText, parseCallBody } from "@/lib/call/call-message";
import { getNotificationPrefs } from "@/lib/realtime/notification-prefs";
import { apiPost, apiPatch, apiDelete } from "@/lib/api-client";
import type { ChatMember, ChatMessage, ConversationSummary } from "@/lib/chat/types";
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
 * The outbox and reply state live here for reason (1) too: an in-flight send
 * survives navigating away mid-send. Composer drafts get the same persistence
 * from lib/chat/draft-store.ts instead — as context state, every keystroke
 * rebuilt this provider's value and re-rendered every consumer.
 */

export type SendStatus = "pending" | "failed";
export type DeleteScope = "me" | "everyone";

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
  replyToId?: string | null;
  createdAt: string;
  status: SendStatus;
  error?: string;
};

/** What the composer is quoting. Held here so it survives a route change. */
export type ReplyTarget = {
  messageId: string;
  senderName: string;
  preview: string;
};

/** What the composer is editing. Mutually exclusive with a reply target. */
export type EditTarget = {
  messageId: string;
  body: string;
};

/** Per-member watermarks, for the tick states. */
export type Receipt = { lastReadAt: string | null; lastDeliveredAt: string | null };

type PresenceEntry = { isOnline: boolean; lastSeenAt: string | null };
type TypingEntry = { username: string; expiresAt: number };

type RealtimeValue = {
  viewerId: string;
  viewerUsername: string;
  connection: "connecting" | "online" | "offline";
  conversations: ConversationSummary[];
  unreadTotal: number;
  presence: Record<string, PresenceEntry>;
  typingIn: (conversationId: string) => string[];
  outboxFor: (conversationId: string) => OutgoingMessage[];
  replyFor: (conversationId: string) => ReplyTarget | null;
  setReply: (conversationId: string, target: ReplyTarget | null) => void;
  editFor: (conversationId: string) => EditTarget | null;
  setEdit: (conversationId: string, target: EditTarget | null) => void;
  /** Everyone else's watermarks in this conversation, keyed by user id. */
  receiptsFor: (conversationId: string) => Record<string, Receipt>;
  seedReceipts: (conversationId: string, members: ChatMember[]) => void;
  sendMessage: (input: Omit<OutgoingMessage, "createdAt" | "status">) => void;
  retryMessage: (clientMsgId: string) => void;
  discardMessage: (clientMsgId: string) => void;
  /** "everyone" tombstones for the whole room; "me" hides it for this user only. */
  deleteMessage: (messageIds: string | string[], scope: DeleteScope) => Promise<string | null>;
  editMessage: (messageId: string, text: string) => Promise<string | null>;
  forwardMessages: (targetConversationId: string, messageIds: string[]) => Promise<string | null>;
  setConversationState: (
    conversationId: string,
    patch: { pinned?: boolean; archived?: boolean; muteMinutes?: number | null },
  ) => Promise<string | null>;
  clearConversation: (conversationId: string, mode: "clear" | "delete") => Promise<string | null>;
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
  viewerUsername,
  initialConversations,
  children,
}: {
  viewerId: string;
  viewerUsername: string;
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
  const [replies, setReplies] = useState<Record<string, ReplyTarget | null>>({});
  const [edits, setEdits] = useState<Record<string, EditTarget | null>>({});
  const [receipts, setReceipts] = useState<Record<string, Record<string, Receipt>>>({});

  const socketRef = useRef<ChatSocket | null>(null);
  // Handlers read this instead of closing over props, so the listener set is
  // registered once rather than rebuilt on every render. Writing a ref inside
  // an effect body is not a setState and doesn't trip the React 19 lint rule.
  const stateRef = useRef({ viewerId, viewerUsername, activeConversationId, conversations });
  useEffect(() => {
    stateRef.current = { viewerId, viewerUsername, activeConversationId, conversations };
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

    // Another tab of *this* user hid a message. Never fires for anyone else —
    // the server emits it only into the actor's own user room.
    const onMessageHidden = ({ conversationId, messageId }: { conversationId: string; messageId: string }) => {
      markLiveMessageHidden(conversationId, messageId);
      // The sidebar preview is computed server-side with the same filter, so a
      // refetch is the honest way to find out what the new last message is —
      // the client can't know, it may be one that was never loaded.
      void refreshConversations();
    };

    const onMessageEdited = ({
      conversationId,
      messageId,
      body,
      editedAt,
    }: {
      conversationId: string;
      messageId: string;
      body: string;
      editedAt: string;
    }) => {
      markLiveMessageEdited(conversationId, messageId, body, editedAt);
      // Patch the sidebar preview in place rather than refetching: an edit
      // deliberately does NOT bump conversation.updatedAt (a week-old message
      // must not jump the chat to the top), so a refetch would return the same
      // order and cost a round trip for one string.
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId && item.lastMessage?.id === messageId
            ? { ...item, lastMessage: { ...item.lastMessage, preview: body.slice(0, 120) } }
            : item,
        ),
      );
    };

    const onReadBy = ({
      conversationId,
      userId,
      lastReadAt,
    }: {
      conversationId: string;
      userId: string;
      lastReadAt: string | null;
    }) => {
      mergeReceipt(conversationId, userId, { lastReadAt });
    };

    const onDeliveredBy = ({
      conversationId,
      userId,
      lastDeliveredAt,
    }: {
      conversationId: string;
      userId: string;
      lastDeliveredAt: string | null;
    }) => {
      mergeReceipt(conversationId, userId, { lastDeliveredAt });
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

    function mergeReceipt(conversationId: string, userId: string, patch: Partial<Receipt>) {
      setReceipts((current) => {
        const room = current[conversationId] ?? {};
        const existing = room[userId] ?? { lastReadAt: null, lastDeliveredAt: null };
        return {
          ...current,
          [conversationId]: { ...room, [userId]: { ...existing, ...patch } },
        };
      });
    }

    function applyIncoming(message: ChatMessage) {
      const { viewerId: me, viewerUsername: myHandle, activeConversationId: active } = stateRef.current;
      const mine = message.senderId === me;
      const visible = typeof document !== "undefined" && document.visibilityState === "visible";

      /**
       * Two different questions, deliberately not the same test.
       *
       * `onScreen` decides whether to TOAST, and does NOT consult
       * document.hasFocus(): if the thread is open and the tab is visible, a
       * popup about the message you are looking at is pure noise even when the
       * window sits behind another. That was the owner's actual complaint.
       *
       * `focused` decides whether to MARK READ, and must keep hasFocus() —
       * silently marking messages read that nobody looked at is worse than a
       * missing toast, and is not undoable.
       */
      const onScreen = active === message.conversationId && visible;
      const focused = onScreen && typeof document !== "undefined" && document.hasFocus();

      // A conversation we don't know about yet (just added to a group) —
      // refetch rather than drop it. Checked against stateRef out here rather
      // than inside the updater: updaters must stay pure (StrictMode
      // double-invokes them), so no fetch may start from within one.
      const known = stateRef.current.conversations.find((item) => item.id === message.conversationId);
      if (!known) void refreshConversations();

      setConversations((current) => {
        const index = current.findIndex((item) => item.id === message.conversationId);
        if (index === -1) return current;
        const updated: ConversationSummary = {
          ...current[index],
          updatedAt: message.createdAt,
          unreadCount: mine || focused ? 0 : current[index].unreadCount + 1,
          // A new message un-archives the conversation, WhatsApp-style. Mirrors
          // what the server does on the next full refresh.
          archivedAt: null,
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

      // The middle tick: tell the sender it reached a real client. Only for
      // messages that are not ours — acking our own send as "delivered to me"
      // is meaningless.
      if (!mine) socketRef.current?.emit("conversation:delivered", { conversationId: message.conversationId });

      if (mine || onScreen) {
        if (focused) markRead(message.conversationId);
        return;
      }

      const prefs = getNotificationPrefs();
      // A direct @mention pierces mute — the one notification people expect to
      // arrive even from a conversation they silenced. It does NOT pierce the
      // global "toasts off" switch, which is an explicit instruction rather
      // than a per-conversation preference.
      const mentioned = mentionsUser(message.body, myHandle);
      const muted = known?.mutedUntil !== null && known?.mutedUntil !== undefined
        ? new Date(known.mutedUntil).getTime() > Date.now()
        : false;
      if (muted && !mentioned) return;

      if (prefs.toasts) {
        notifyIncomingMessage({
          conversationId: message.conversationId,
          title: conversationTitle(known),
          preview: previewOf(message),
          mentioned,
          onOpen: () => router.push(`/chats/${message.conversationId}`),
        });
      }
      if (prefs.sound) playBlip();
      if (prefs.titleBlink && typeof document !== "undefined" && document.visibilityState === "hidden") {
        startBlink(unreadTotalOf(stateRef.current.conversations) + 1);
      }
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("message:new", onMessageNew);
    socket.on("message:deleted", onMessageDeleted);
    socket.on("message:hidden", onMessageHidden);
    socket.on("message:edited", onMessageEdited);
    socket.on("conversation:read-by", onReadBy);
    socket.on("conversation:delivered", onDeliveredBy);
    socket.on("presence:online", onPresenceOnline);
    socket.on("presence:offline", onPresenceOffline);
    socket.on("typing:start", onTypingStart);
    socket.on("typing:stop", onTypingStop);
    socket.on("conversation:added", onConversationAdded);
    socket.on("conversation:removed", onConversationChanged);
    socket.on("conversation:updated", onConversationChanged);
    socket.on("conversation:self-changed", onConversationChanged);
    socket.on("conversation:read-sync", onReadSync);

    if (socket.connected) onConnect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("message:new", onMessageNew);
      socket.off("message:deleted", onMessageDeleted);
      socket.off("message:hidden", onMessageHidden);
      socket.off("message:edited", onMessageEdited);
        socket.off("conversation:read-by", onReadBy);
      socket.off("conversation:delivered", onDeliveredBy);
      socket.off("presence:online", onPresenceOnline);
      socket.off("presence:offline", onPresenceOffline);
      socket.off("typing:start", onTypingStart);
      socket.off("typing:stop", onTypingStop);
      socket.off("conversation:added", onConversationAdded);
      socket.off("conversation:removed", onConversationChanged);
      socket.off("conversation:updated", onConversationChanged);
      socket.off("conversation:self-changed", onConversationChanged);
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
            replyToId: entry.replyToId ?? undefined,
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

  const deleteMessage = useCallback(
    async (messageIds: string | string[], scope: DeleteScope): Promise<string | null> => {
      const socket = socketRef.current;
      if (!socket) return "You're offline";
      const ids = Array.isArray(messageIds) ? messageIds : [messageIds];
      if (ids.length === 0) return null;
      const event = scope === "me" ? "message:delete-for-me" : "message:delete";
      return new Promise((resolve) => {
        socket
          .timeout(SEND_TIMEOUT_MS)
          .emit(
            event,
            // Both keys, always. The server reads messageIds when present and
            // falls back to messageId, so this one payload satisfies the old
            // and new shapes at once.
            { messageId: ids[0], messageIds: ids },
            (
              timeoutError: Error | null,
              response?: { ok: boolean; error?: string; conversationId?: string; messageIds?: string[] },
            ) => {
              if (timeoutError || !response?.ok) {
                resolve(response?.error ?? (scope === "me" ? "Couldn't remove that" : "Couldn't delete that"));
                return;
              }
              // "everyone" is echoed back to the whole room, so that path updates
              // itself. A hide reaches only this user's *other* tabs, so the
              // acting socket is the one that has to apply it locally — hence the
              // conversationId in the ack.
              if (scope === "me" && response.conversationId) {
                for (const id of response.messageIds ?? ids) {
                  markLiveMessageHidden(response.conversationId, id);
                }
                void refreshConversations();
              }
              resolve(null);
            },
          );
      });
    },
    [refreshConversations],
  );

  const editMessage = useCallback(async (messageId: string, text: string): Promise<string | null> => {
    const socket = socketRef.current;
    if (!socket) return "You're offline";
    return new Promise((resolve) => {
      socket
        .timeout(SEND_TIMEOUT_MS)
        .emit(
          "message:edit",
          { messageId, text },
          (
            timeoutError: Error | null,
            response?: { ok: boolean; error?: string; conversationId?: string; body?: string; editedAt?: string },
          ) => {
            if (timeoutError || !response?.ok) {
              resolve(response?.error ?? "Couldn't save that edit");
              return;
            }
            // The edit IS broadcast to the whole room including this socket, so
            // this local apply is belt and braces — markLiveMessageEdited is
            // idempotent, and it makes the change land instantly rather than at
            // network latency.
            if (response.conversationId && response.body && response.editedAt) {
              markLiveMessageEdited(response.conversationId, messageId, response.body, response.editedAt);
            }
            resolve(null);
          },
        );
    });
  }, []);

  const forwardMessages = useCallback(
    async (targetConversationId: string, messageIds: string[]): Promise<string | null> => {
      const result = await apiPost<{ success: boolean }>(
        `/api/conversations/${targetConversationId}/forward`,
        { messageIds },
      );
      if (!result.ok) return result.data.error ?? "Couldn't forward that";
      await refreshConversations();
      return null;
    },
    [refreshConversations],
  );

  const setConversationState = useCallback<RealtimeValue["setConversationState"]>(
    async (conversationId, patch) => {
      const result = await apiPatch<{
        pinnedAt: string | null;
        mutedUntil: string | null;
        archivedAt: string | null;
      }>(`/api/conversations/${conversationId}/state`, patch);
      if (!result.ok) return result.data.error ?? "Couldn't update that";
      // Patched in place, not refetched: the server answered with the three new
      // values, and a full sidebar rebuild for a pin toggle is four queries for
      // information already in hand.
      setConversations((current) =>
        current.map((item) =>
          item.id === conversationId
            ? {
                ...item,
                pinnedAt: result.data.pinnedAt,
                mutedUntil: result.data.mutedUntil,
                archivedAt: result.data.archivedAt,
              }
            : item,
        ),
      );
      // Pinning changes the ORDER, which the patch above cannot do correctly —
      // the server merges pinned rows ahead of the keyset page. So this one
      // does need a refetch, deliberately after the optimistic patch so the
      // switch flips instantly.
      if (patch.pinned !== undefined) void refreshConversations();
      return null;
    },
    [refreshConversations],
  );

  const clearConversation = useCallback<RealtimeValue["clearConversation"]>(
    async (conversationId, mode) => {
      const result = await apiDelete<{ success: boolean }>(`/api/conversations/${conversationId}`, { mode });
      if (!result.ok) return result.data.error ?? "Couldn't do that";
      // Both modes change what history exists, so the sidebar has to come from
      // the server — the client cannot know what the new last message is.
      await refreshConversations();
      return null;
    },
    [refreshConversations],
  );

  const emitTyping = useCallback((conversationId: string, isTyping: boolean) => {
    socketRef.current?.emit(isTyping ? "typing:start" : "typing:stop", { conversationId });
  }, []);

  const setReply = useCallback((conversationId: string, target: ReplyTarget | null) => {
    setReplies((current) => ({ ...current, [conversationId]: target }));
    // Replying to something while an edit is open is contradictory — the
    // composer can only be doing one of the two.
    if (target) setEdits((current) => ({ ...current, [conversationId]: null }));
  }, []);

  const setEdit = useCallback((conversationId: string, target: EditTarget | null) => {
    setEdits((current) => ({ ...current, [conversationId]: target }));
    if (target) setReplies((current) => ({ ...current, [conversationId]: null }));
  }, []);

  const seedReceipts = useCallback((conversationId: string, members: ChatMember[]) => {
    setReceipts((current) => {
      const room: Record<string, Receipt> = {};
      for (const member of members) {
        // Key presence, not truthiness: a member whose privacy hides their
        // presence has no lastReadAt key at all, and must get no entry here —
        // an entry of nulls would render as "sent but never delivered", which
        // is a claim rather than an absence.
        if (!("lastReadAt" in member)) continue;
        room[member.id] = {
          lastReadAt: member.lastReadAt ?? null,
          lastDeliveredAt: member.lastDeliveredAt ?? null,
        };
      }
      // Merged under whatever the socket has already reported, so a receipt
      // that arrived before the thread mounted is not overwritten by the
      // server's older snapshot.
      return { ...current, [conversationId]: { ...room, ...(current[conversationId] ?? {}) } };
    });
  }, []);

  useEffect(() => {
    return () => clearLiveMessages();
  }, []);

  const unreadTotal = useMemo(() => unreadTotalOf(conversations), [conversations]);

  const value = useMemo<RealtimeValue>(
    () => ({
      viewerId,
      viewerUsername,
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
      replyFor: (conversationId) => replies[conversationId] ?? null,
      setReply,
      editFor: (conversationId) => edits[conversationId] ?? null,
      setEdit,
      receiptsFor: (conversationId) => receipts[conversationId] ?? EMPTY_RECEIPTS,
      seedReceipts,
      sendMessage,
      retryMessage,
      discardMessage,
      deleteMessage,
      editMessage,
      forwardMessages,
      setConversationState,
      clearConversation,
      markRead,
      emitTyping,
      refreshConversations,
    }),
    [
      viewerId,
      viewerUsername,
      connection,
      conversations,
      unreadTotal,
      presence,
      typing,
      outbox,
      replies,
      edits,
      receipts,
      setReply,
      setEdit,
      seedReceipts,
      sendMessage,
      retryMessage,
      discardMessage,
      deleteMessage,
      editMessage,
      forwardMessages,
      setConversationState,
      clearConversation,
      markRead,
      emitTyping,
      refreshConversations,
    ],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

// One shared object, so receiptsFor() on a conversation with no receipts yet
// returns the same reference every render rather than a fresh {} that would
// invalidate every memo downstream.
const EMPTY_RECEIPTS: Record<string, Receipt> = Object.freeze({});

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
      // Viewer-neutral wording — a preview has no viewer role. Null-safe: "Call".
      return callPreviewText(parseCallBody(message.body));
    default:
      return (message.body ?? "").slice(0, 120);
  }
}

// Re-exported so the thread can backfill after a reconnect without importing
// the store directly from two places.
export { pushLiveMessages };
