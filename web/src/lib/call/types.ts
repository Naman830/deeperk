import type { ConversationType } from "@/lib/chat/types";

// The call wire contract. Mirrored by hand in server/src/controllers/call/
// (the server is CommonJS and cannot import this file) — change both or neither.

export type CallKind = "AUDIO" | "VIDEO";
/** How a finished call ended — what lands in the CALL bubble's body JSON. */
export type CallTerminalStatus = "ENDED" | "MISSED" | "REJECTED";
/** A live call's server-side state, as reported by call:state. */
export type CallLiveStatus = "RINGING" | "ONGOING";

/** Client builds avatar URLs from avatarPublicId via lib/avatar-url.ts. */
export type CallUser = {
  id: string;
  username: string;
  firstName: string;
  lastName: string | null;
  avatarPublicId: string | null;
};

/** Ack codes. NOT_FOUND covers blocked and non-member alike — never probeable. */
export type CallErrorCode =
  | "UNAUTHENTICATED"
  | "INVALID"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "SELF_BUSY"
  | "PEER_BUSY"
  | "CALL_ACTIVE"
  | "CALL_FULL"
  | "CALL_ENDED"
  | "OFFLINE"
  | "SERVER_ERROR";

export type CallFailAck = {
  ok: false;
  code: CallErrorCode;
  error: string;
  /** CALL_ACTIVE only — the conversation's existing live call, for the client to pivot to. */
  callId?: string;
  kind?: CallKind;
};

export type CallAck<T> = ({ ok: true } & T) | CallFailAck;

/** simple-peer-style: an SDP description or a wrapped ICE candidate. Opaque to the server. */
export type PeerSignalData =
  | { type: "offer" | "answer"; sdp: string }
  | { candidate: RTCIceCandidateInit };

// --- client → server payloads + success acks --------------------------------

export type CallInvitePayload = { conversationId: string; kind: CallKind };
export type CallInviteOk = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  ringingUserIds: string[];
  iceServers: RTCIceServer[];
  ringTimeoutMs: number;
};

/** call:accept / call:join / call:cancel / call:reject / call:leave. */
export type CallIdPayload = { callId: string };

/** Accepter/joiner creates NO peers eagerly — incumbents offer (call.md §2.4). */
export type CallJoinOk = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  /** Already joined, excluding self. */
  participants: CallUser[];
  iceServers: RTCIceServer[];
};

export type CallCancelOk = { callId: string };
export type CallRejectOk = { callId: string };
export type CallLeaveOk = { callId: string; ended: boolean };

export type RtcSignalPayload = { callId: string; to: string; data: PeerSignalData };

/** Fire-and-forget — no ack. */
export type CallMuteStatePayload = { callId: string; micMuted: boolean; cameraOff: boolean };

export type CallStateSelf = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  status: CallLiveStatus;
  participants: CallUser[];
  iceServers: RTCIceServer[];
};

/** One live call per conversation the user belongs to. */
export type OngoingCallInfo = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  participantCount: number;
};

export type CallStateOk = { self: CallStateSelf | null; ongoing: OngoingCallInfo[] };

// --- server → client events -------------------------------------------------

export type CallRingEvent = {
  callId: string;
  conversationId: string;
  conversationType: ConversationType;
  conversationName: string | null;
  kind: CallKind;
  caller: CallUser;
  startedAt: string;
  ringTimeoutMs: number;
};

export type CallStartedEvent = {
  callId: string;
  conversationId: string;
  kind: CallKind;
  startedById: string;
  startedAt: string;
};

/** Fires on EVERY join incl. re-join — the §2.4 offer rule and the re-peer trigger. */
export type CallParticipantJoinedEvent = {
  callId: string;
  conversationId: string;
  user: CallUser;
  joinedUserIds: string[];
};

export type CallParticipantLeftEvent = {
  callId: string;
  conversationId: string;
  userId: string;
  joinedUserIds: string[];
};

export type CallEndedEvent = {
  callId: string;
  conversationId: string;
  status: CallTerminalStatus;
  endedAt: string;
};

/** Ring window closed, call continues — dismiss the modal, keep the banner. */
export type CallRingCancelledEvent = { callId: string; conversationId: string };

/** Group reject, delivered to the rejecter's own tabs only. */
export type CallRingHandledEvent = { callId: string; action: "REJECTED" };

export type RtcSignalEvent = { callId: string; from: string; data: PeerSignalData };

export type CallMuteStateEvent = {
  callId: string;
  userId: string;
  micMuted: boolean;
  cameraOff: boolean;
};
