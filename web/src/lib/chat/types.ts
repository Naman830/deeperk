// Shapes shared by the REST routes, the server components and the socket
// client. The socket server (server/, CommonJS) can't import this file, so any
// change here has a mirror over there — the event names in SOCKET_EVENTS are
// the contract between the two.

export type ConversationType = "DIRECT" | "GROUP";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
export type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "SYSTEM" | "CALL";

/** Only these can arrive from a client. SYSTEM and CALL are server-authored:
 *  accepting them would let any member forge "Alice removed Bob". */
export const SENDABLE_MESSAGE_TYPES = ["TEXT", "IMAGE", "VIDEO", "FILE"] as const;
export type SendableMessageType = (typeof SENDABLE_MESSAGE_TYPES)[number];

export type ChatUser = {
  id: string;
  username: string;
  displayUsername: string;
  firstName: string;
  lastName: string | null;
  avatarUrl: string | null;
  // Absent, not null, when the subject's onlineStatus hides them. Branch on
  // key presence — `isOnline: false` and "hidden" are different states.
  isOnline?: boolean;
  lastSeenAt?: string | null;
};

export type ChatMember = ChatUser & {
  role: MemberRole;
  joinedAt: string;
  /**
   * Read / delivery watermarks. ABSENT (not null) when the member's
   * onlineStatus privacy hides them — branch on key presence, exactly like
   * isOnline. Your own are always present.
   */
  lastReadAt?: string | null;
  lastDeliveredAt?: string | null;
};

export type ChatMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  type: MessageType;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  mediaSize: number | null;
  mediaName: string | null;
  /** Intrinsic pixel size, images only — lets a bubble reserve its aspect box. */
  mediaWidth: number | null;
  mediaHeight: number | null;
  callId: string | null;
  clientMsgId: string | null;
  /** Quoted message, or null. The quoted content itself is resolved separately. */
  replyToId: string | null;
  createdAt: string;
  /** Non-null once the body has been edited. */
  editedAt: string | null;
  deletedAt: string | null;
};

export type ConversationSummary = {
  id: string;
  type: ConversationType;
  name: string | null;
  avatarUrl: string | null;
  updatedAt: string;
  role: MemberRole;
  lastReadAt: string | null;
  unreadCount: number;
  memberCount: number;
  /** Per-member state — yours alone, never the other members'. */
  pinnedAt: string | null;
  mutedUntil: string | null;
  archivedAt: string | null;
  /** DIRECT only — the other participant. */
  otherUser?: ChatUser;
  lastMessage: {
    id: string;
    senderId: string;
    type: MessageType;
    preview: string;
    createdAt: string;
    deletedAt: string | null;
  } | null;
};

export type ConversationDetail = {
  id: string;
  type: ConversationType;
  name: string | null;
  avatarUrl: string | null;
  createdAt: string;
  role: MemberRole;
  lastReadAt: string | null;
  pinnedAt: string | null;
  mutedUntil: string | null;
  archivedAt: string | null;
  members: ChatMember[];
};

export const SOCKET_EVENTS = {
  // client → server
  MESSAGE_SEND: "message:send",
  MESSAGE_DELETE: "message:delete",
  MESSAGE_DELETE_FOR_ME: "message:delete-for-me",
  MESSAGE_EDIT: "message:edit",
  TYPING_START: "typing:start",
  TYPING_STOP: "typing:stop",
  CONVERSATION_READ: "conversation:read",
  /** Recipient-side "it reached my client" — the middle tick. */
  CONVERSATION_DELIVERED: "conversation:delivered",
  // server → client
  READY: "session:ready",
  MESSAGE_NEW: "message:new",
  MESSAGE_DELETED: "message:deleted",
  /** Hidden for one user only — sent to that user's own tabs, never the room. */
  MESSAGE_HIDDEN: "message:hidden",
  MESSAGE_EDITED: "message:edited",
  CONVERSATION_ADDED: "conversation:added",
  CONVERSATION_REMOVED: "conversation:removed",
  CONVERSATION_UPDATED: "conversation:updated",
  CONVERSATION_READ_SYNC: "conversation:read-sync",
  /** Someone ELSE read the conversation — the blue tick. Privacy-gated server-side. */
  CONVERSATION_READ_BY: "conversation:read-by",
  CONVERSATION_DELIVERED_BY: "conversation:delivered",
  PRESENCE_ONLINE: "presence:online",
  PRESENCE_OFFLINE: "presence:offline",
  CHAT_ERROR: "chat:error",
} as const;

/** Ack codes. NOT_FOUND deliberately covers both "no such conversation" and
 *  "you're not a member", so an id can't be probed for existence. */
export type ChatErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID"
  | "TOO_LONG"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SERVER_ERROR";

export type ChatAck<T> = ({ ok: true } & T) | { ok: false; code: ChatErrorCode; error: string };
