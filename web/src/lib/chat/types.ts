// Shapes shared by the REST routes, the server components and the socket
// client. The socket server (server/, CommonJS) can't import this file, so any
// change here has a mirror over there — the event names are string literals at
// the call sites (realtime-provider.tsx ↔ server/src/controllers/).

export type ConversationType = "DIRECT" | "GROUP";
export type MemberRole = "OWNER" | "ADMIN" | "MEMBER";
export type MessageType = "TEXT" | "IMAGE" | "VIDEO" | "FILE" | "AUDIO" | "SYSTEM" | "CALL";

/** Only these can arrive from a client. SYSTEM and CALL are server-authored:
 *  accepting them would let any member forge "Alice removed Bob". */
export const SENDABLE_MESSAGE_TYPES = ["TEXT", "IMAGE", "VIDEO", "FILE", "AUDIO"] as const;
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
  /** AUDIO (voice notes) only — Chrome-recorded webm reports Infinity from the
   *  element, so the player's total time depends on this. */
  mediaDurationMs: number | null;
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
