import type { ConversationType } from "@/lib/chat/types";
import type { CallKind, CallUser, OngoingCallInfo } from "./types";

/**
 * Renderable call state, in a module store — same useSyncExternalStore protocol
 * as live-store.ts / draft-store.ts. The session controller (session.ts) is the
 * only writer; components render frozen snapshots, which is what lets a call
 * survive navigating to /settings and back.
 *
 * Narrow getters on purpose: getCallState is for the overlay root only,
 * getCallPhase is the cheap gate for buttons, getOngoingCall the stable-entry
 * slice for the group join banner. Subscribing a bubble-adjacent component to
 * the full state would re-render it on every tick of call plumbing.
 */

export type CallPhase = "idle" | "outgoing" | "incoming" | "active" | "reconnecting";
export type PeerConnectionState = "connecting" | "connected";
export type MinimizedCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export type CallParticipant = {
  user: CallUser;
  stream: MediaStream | null;
  micMuted: boolean;
  cameraOff: boolean;
  connection: PeerConnectionState;
};

export type CallState = {
  phase: CallPhase;
  callId: string | null;
  conversationId: string | null;
  conversationType: ConversationType | null;
  conversationName: string | null;
  kind: CallKind | null;
  /** Incoming ring only — who is calling. */
  caller: CallUser | null;
  /** Joining an already-live call (banner / rejoin), not ringing anyone. */
  joining: boolean;
  /** App clock, stamped when the call went active — duration renders from it. */
  startedAt: number | null;
  localStream: MediaStream | null;
  micMuted: boolean;
  cameraOff: boolean;
  /** VIDEO call joined without a camera (broken/blocked device, audio-only retry). */
  cameraless: boolean;
  /** Inline getUserMedia failure — rendered on the surface, never a toast. */
  mediaError: string | null;
  participants: readonly CallParticipant[];
  minimized: boolean;
  minimizedCorner: MinimizedCorner;
};

const EMPTY_PARTICIPANTS: readonly CallParticipant[] = Object.freeze([]);

const IDLE_STATE: CallState = Object.freeze({
  phase: "idle" as const,
  callId: null,
  conversationId: null,
  conversationType: null,
  conversationName: null,
  kind: null,
  caller: null,
  joining: false,
  startedAt: null,
  localStream: null,
  micMuted: false,
  cameraOff: false,
  cameraless: false,
  mediaError: null,
  participants: EMPTY_PARTICIPANTS,
  minimized: false,
  minimizedCorner: "bottom-right" as const,
});

let state: CallState = IDLE_STATE;
/** Live calls elsewhere, keyed by conversationId. Entries are frozen and reused
 *  when unchanged so the banner's slice stays referentially stable. */
const ongoing = new Map<string, OngoingCallInfo>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function commit(next: CallState): void {
  state = Object.freeze(next);
  emit();
}

export function subscribeCall(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCallState(): CallState {
  return state;
}

/** Stable and always idle — the server never has a call. */
export function getServerCallState(): CallState {
  return IDLE_STATE;
}

export function getCallPhase(): CallPhase {
  return state.phase;
}

export function getServerCallPhase(): CallPhase {
  return "idle";
}

export function getOngoingCall(conversationId: string): OngoingCallInfo | null {
  return ongoing.get(conversationId) ?? null;
}

export function getServerOngoingCall(): null {
  return null;
}

// --- call lifecycle mutators (one emit each) --------------------------------

export function beginOutgoing(input: {
  conversationId: string;
  conversationType: ConversationType;
  conversationName: string | null;
  kind: CallKind;
  joining: boolean;
}): void {
  if (state.phase !== "idle") return;
  commit({ ...IDLE_STATE, ...input, phase: "outgoing", minimizedCorner: state.minimizedCorner });
}

export function setIncoming(input: {
  callId: string;
  conversationId: string;
  conversationType: ConversationType;
  conversationName: string | null;
  kind: CallKind;
  caller: CallUser;
}): void {
  if (state.phase !== "idle") return;
  commit({ ...IDLE_STATE, ...input, phase: "incoming", minimizedCorner: state.minimizedCorner });
}

export function setCallId(callId: string): void {
  if (state.phase === "idle" || state.callId === callId) return;
  commit({ ...state, callId });
}

export function setMediaError(message: string | null): void {
  if (state.phase === "idle" || state.mediaError === message) return;
  commit({ ...state, mediaError: message });
}

export function setLocalStream(stream: MediaStream, cameraless: boolean): void {
  if (state.phase === "idle") return; // torn down while getUserMedia was up
  commit({ ...state, localStream: stream, cameraless, micMuted: false, cameraOff: false, mediaError: null });
}

export function setActive(input: { callId?: string; conversationId?: string; kind?: CallKind }): void {
  if (state.phase === "idle") return; // torn down while an ack was in flight
  commit({
    ...state,
    phase: "active",
    callId: input.callId ?? state.callId,
    conversationId: input.conversationId ?? state.conversationId,
    kind: input.kind ?? state.kind,
    joining: false,
    startedAt: state.startedAt ?? Date.now(),
  });
}

/** Only ever flips between active and reconnecting. */
export function setPhase(phase: "active" | "reconnecting"): void {
  if (state.phase !== "active" && state.phase !== "reconnecting") return;
  if (state.phase === phase) return;
  commit({ ...state, phase });
}

export function resetCall(): void {
  if (state.phase === "idle") return;
  commit({ ...IDLE_STATE, minimizedCorner: state.minimizedCorner });
}

// --- participants -----------------------------------------------------------

function freshParticipant(user: CallUser): CallParticipant {
  return { user, stream: null, micMuted: false, cameraOff: false, connection: "connecting" };
}

/** Merge a server participant list, keeping existing entries (and their stream
 *  identity). `prune` drops entries the server no longer reports — resync only. */
export function syncParticipants(users: CallUser[], opts?: { prune?: boolean }): void {
  if (state.phase === "idle") return;
  const prev = state.participants;
  const leftover = new Map(prev.map((p) => [p.user.id, p]));
  const next: CallParticipant[] = users.map((user) => {
    const existing = leftover.get(user.id);
    if (existing) {
      leftover.delete(user.id);
      return existing;
    }
    return freshParticipant(user);
  });
  if (!opts?.prune) for (const p of prev) if (leftover.has(p.user.id)) next.push(p);
  if (next.length === prev.length && next.every((p, i) => p === prev[i])) return;
  commit({ ...state, participants: next });
}

export function upsertParticipant(user: CallUser): void {
  if (state.phase === "idle") return;
  if (state.participants.some((p) => p.user.id === user.id)) return;
  commit({ ...state, participants: [...state.participants, freshParticipant(user)] });
}

export function removeParticipant(userId: string): void {
  const next = state.participants.filter((p) => p.user.id !== userId);
  if (next.length === state.participants.length) return;
  commit({ ...state, participants: next });
}

function patchParticipant(userId: string, patch: Partial<Omit<CallParticipant, "user">>): void {
  const index = state.participants.findIndex((p) => p.user.id === userId);
  if (index === -1) return;
  const current = state.participants[index];
  const merged: CallParticipant = { ...current, ...patch };
  if (
    merged.stream === current.stream &&
    merged.micMuted === current.micMuted &&
    merged.cameraOff === current.cameraOff &&
    merged.connection === current.connection
  ) {
    return;
  }
  const participants = [...state.participants];
  participants[index] = merged;
  commit({ ...state, participants });
}

export function setParticipantStream(userId: string, stream: MediaStream): void {
  patchParticipant(userId, { stream });
}

export function setParticipantConnection(userId: string, connection: PeerConnectionState): void {
  patchParticipant(userId, { connection });
}

export function setParticipantMute(userId: string, micMuted: boolean, cameraOff: boolean): void {
  patchParticipant(userId, { micMuted, cameraOff });
}

// --- self + surface ---------------------------------------------------------

export function setSelfMute(input: { micMuted?: boolean; cameraOff?: boolean }): void {
  if (state.phase === "idle") return;
  const micMuted = input.micMuted ?? state.micMuted;
  const cameraOff = input.cameraOff ?? state.cameraOff;
  if (micMuted === state.micMuted && cameraOff === state.cameraOff) return;
  commit({ ...state, micMuted, cameraOff });
}

export function setMinimized(minimized: boolean): void {
  if (state.minimized === minimized) return;
  commit({ ...state, minimized });
}

export function setMinimizedCorner(corner: MinimizedCorner): void {
  if (state.minimizedCorner === corner) return;
  commit({ ...state, minimizedCorner: corner });
}

// --- ongoing calls elsewhere ------------------------------------------------

export function replaceOngoing(entries: OngoingCallInfo[]): void {
  let changed = ongoing.size !== entries.length;
  const next = new Map<string, OngoingCallInfo>();
  for (const entry of entries) {
    const prev = ongoing.get(entry.conversationId);
    if (
      prev &&
      prev.callId === entry.callId &&
      prev.kind === entry.kind &&
      prev.participantCount === entry.participantCount
    ) {
      next.set(entry.conversationId, prev);
    } else {
      next.set(entry.conversationId, Object.freeze({ ...entry }));
      changed = true;
    }
  }
  if (!changed) return;
  ongoing.clear();
  for (const [key, value] of next) ongoing.set(key, value);
  emit();
}

export function addOngoing(entry: OngoingCallInfo): void {
  const prev = ongoing.get(entry.conversationId);
  if (
    prev &&
    prev.callId === entry.callId &&
    prev.kind === entry.kind &&
    prev.participantCount === entry.participantCount
  ) {
    return;
  }
  ongoing.set(entry.conversationId, Object.freeze({ ...entry }));
  emit();
}

export function setOngoingCount(callId: string, participantCount: number): void {
  for (const [conversationId, entry] of ongoing) {
    if (entry.callId !== callId) continue;
    if (entry.participantCount === participantCount) return;
    ongoing.set(conversationId, Object.freeze({ ...entry, participantCount }));
    emit();
    return;
  }
}

export function removeOngoing(callId: string): void {
  for (const [conversationId, entry] of ongoing) {
    if (entry.callId !== callId) continue;
    ongoing.delete(conversationId);
    emit();
    return;
  }
}
