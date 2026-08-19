import { toast } from "react-toastify";
import type { ChatSocket } from "@/lib/realtime/socket";
import { primeAudioContext } from "@/lib/realtime/audio-context";
import { getNotificationPrefs } from "@/lib/realtime/notification-prefs";
import { isMuted } from "@/lib/hooks/use-now";
import type { ConversationSummary } from "@/lib/chat/types";
import { CallPeer } from "./peer";
import { startRingtone, stopRingtone } from "./ringtone";
import {
  addOngoing,
  beginOutgoing,
  getCallPhase,
  getCallState,
  getOngoingCall,
  removeOngoing,
  removeParticipant,
  replaceOngoing,
  resetCall,
  setActive,
  setCallId,
  setIncoming,
  setLocalStream,
  setMediaError,
  setOngoingCount,
  setParticipantConnection,
  setParticipantMute,
  setParticipantStream,
  setPhase,
  setSelfMute,
  syncParticipants,
  upsertParticipant,
} from "./call-store";
import type {
  CallAck,
  CallEndedEvent,
  CallFailAck,
  CallInviteOk,
  CallJoinOk,
  CallKind,
  CallMuteStateEvent,
  CallParticipantJoinedEvent,
  CallParticipantLeftEvent,
  CallRingCancelledEvent,
  CallRingEvent,
  CallRingHandledEvent,
  CallStartedEvent,
  CallStateOk,
  CallStateSelf,
  CallUser,
  RtcSignalEvent,
} from "./types";

/**
 * The non-React call controller. Owns getUserMedia, the peer mesh and every
 * timer; writes renderable state into call-store. Module lifetime is what lets
 * a call survive navigation — components only ever render store snapshots.
 */

export type CallSessionDeps = {
  /** Ref-reads into RealtimeProvider state — read at call time, never captured. */
  getViewerId: () => string;
  getConversations: () => ConversationSummary[];
};

const ACK_TIMEOUT_MS = 10_000;
const CONNECT_WINDOW_MS = 20_000;
// Belt-and-braces dismiss for a ring whose closing event was lost in transit.
const RING_FAILSAFE_EXTRA_MS = 5_000;

type PeerEntry = { userId: string; initiator: boolean; retried: boolean; peer: CallPeer };
type AcquiredMedia = { stream: MediaStream; cameraless: boolean };

let socketRef: ChatSocket | null = null;
let depsRef: CallSessionDeps | null = null;
let iceServers: RTCIceServer[] = [];
const peers = new Map<string, PeerEntry>();
const connectTimers = new Map<string, ReturnType<typeof setTimeout>>();
let ringFailsafe: ReturnType<typeof setTimeout> | null = null;
let detachCurrent: (() => void) | null = null;
// Set while our own accept/join ack is in flight. Long-polling can deliver the
// ack and our own participant-joined echo in ONE poll batch; socket.io then
// runs the echo handler synchronously before the ack's microtask continuation,
// so without this marker the accepting tab reads its own echo as "another tab
// answered" and tears itself down.
let pendingJoinCallId: string | null = null;
let accepting = false; // double-click guard for acceptCall

// --- small helpers ----------------------------------------------------------

function callToastId(callId: string): string {
  return `call:${callId}`;
}

function displayName(user: CallUser): string {
  return `${user.firstName} ${user.lastName ?? ""}`.trim();
}

function counterpartName(conversation: ConversationSummary | undefined): string {
  const other = conversation?.otherUser;
  return other ? `${other.firstName} ${other.lastName ?? ""}`.trim() : "This user";
}

function surfaceName(conversation: ConversationSummary | undefined): string | null {
  if (!conversation) return null;
  return conversation.type === "GROUP" ? (conversation.name ?? "Group") : counterpartName(conversation);
}

function findConversation(conversationId: string): ConversationSummary | undefined {
  return depsRef?.getConversations().find((c) => c.id === conversationId);
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function clearRingFailsafe(): void {
  if (ringFailsafe !== null) {
    clearTimeout(ringFailsafe);
    ringFailsafe = null;
  }
}

function emitAck<T>(event: string, payload: unknown): Promise<CallAck<T> | null> {
  return new Promise((resolve) => {
    const socket = socketRef;
    if (!socket) {
      resolve(null);
      return;
    }
    socket.timeout(ACK_TIMEOUT_MS).emit(event, payload, (timeoutError: Error | null, response?: CallAck<T>) => {
      resolve(timeoutError ? null : (response ?? null));
    });
  });
}

async function acquireMedia(kind: CallKind): Promise<AcquiredMedia> {
  if (kind === "VIDEO") {
    try {
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: true, video: true }), cameraless: false };
    } catch {
      // A broken/blocked camera must not sink the call — retry audio-only; kind stays VIDEO.
      return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), cameraless: true };
    }
  }
  return { stream: await navigator.mediaDevices.getUserMedia({ audio: true }), cameraless: false };
}

function mediaErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : null;
  switch (name) {
    case "NotAllowedError":
      return "Microphone access is blocked — allow it in your browser's site settings and try again.";
    case "NotFoundError":
      return "No microphone was found on this device.";
    case "NotReadableError":
      return "Your microphone is already in use by another app.";
    default:
      return "Couldn't access your microphone.";
  }
}

/** Destroy everything this session holds. The camera light must never outlive the call. */
function teardown(): void {
  const entries = [...peers.values()];
  peers.clear(); // cleared first so each destroy()'s onClose sees itself already gone
  for (const entry of entries) entry.peer.destroy();
  for (const timer of connectTimers.values()) clearTimeout(timer);
  connectTimers.clear();
  clearRingFailsafe();
  stopRingtone();
  const stream = getCallState().localStream;
  if (stream) stopTracks(stream);
  resetCall();
}

// --- peer mesh --------------------------------------------------------------

function armConnectTimer(userId: string): void {
  if (connectTimers.has(userId)) return; // a retry does not extend the original window
  connectTimers.set(userId, setTimeout(() => onConnectWindowExpired(userId), CONNECT_WINDOW_MS));
}

function clearConnectTimer(userId: string): void {
  const timer = connectTimers.get(userId);
  if (timer) {
    clearTimeout(timer);
    connectTimers.delete(userId);
  }
}

function createPeer(userId: string, initiator: boolean, retried = false): PeerEntry | null {
  const state = getCallState();
  const { localStream: stream, callId } = state;
  if (!stream || !callId) return null;
  // peer is filled in on the next line, before any callback can run — CallPeer
  // never fires synchronously from its constructor.
  const entry: PeerEntry = { userId, initiator, retried, peer: undefined as unknown as CallPeer };
  entry.peer = new CallPeer({
    initiator,
    stream,
    iceServers,
    onSignal: (data) => socketRef?.emit("rtc:signal", { callId, to: userId, data }),
    onStream: (remote) => {
      if (peers.get(userId) === entry) setParticipantStream(userId, remote);
    },
    onConnect: () => {
      if (peers.get(userId) !== entry) return;
      clearConnectTimer(userId);
      entry.retried = false; // a later drop earns a fresh retry
      setParticipantConnection(userId, "connected");
    },
    onClose: () => handlePeerClose(userId, entry),
  });
  peers.set(userId, entry);
  return entry;
}

function handlePeerClose(userId: string, entry: PeerEntry): void {
  if (peers.get(userId) !== entry) return; // deliberately replaced or removed — not a failure
  peers.delete(userId);
  const phase = getCallPhase();
  if (phase !== "active" && phase !== "reconnecting") return;
  setParticipantConnection(userId, "connecting");
  // Initiator retries once with a fresh offer; the connect window is the final arbiter.
  if (entry.initiator && !entry.retried) {
    createPeer(userId, true, true);
    armConnectTimer(userId);
  }
}

function onConnectWindowExpired(userId: string): void {
  connectTimers.delete(userId);
  const state = getCallState();
  if (state.phase !== "active" && state.phase !== "reconnecting") return;
  const participant = state.participants.find((p) => p.user.id === userId);
  if (!participant || participant.connection === "connected") return;
  if (state.conversationType === "DIRECT") {
    if (state.callId) toast.error("Couldn't connect — check your network", { toastId: callToastId(state.callId) });
    hangUp();
    return;
  }
  // Group: drop the tile; a re-join from their side brings it back.
  const entry = peers.get(userId);
  if (entry) {
    peers.delete(userId);
    entry.peer.destroy();
  }
  removeParticipant(userId);
}

// --- public API -------------------------------------------------------------

export async function startCall(conversationId: string, kind: CallKind): Promise<void> {
  if (getCallPhase() !== "idle") return;
  primeAudioContext(); // inside the click gesture — in-call audio must not depend on prior priming
  const conversation = findConversation(conversationId);
  // Surface first, then getUserMedia — a permission error needs a home on screen.
  beginOutgoing({
    conversationId,
    conversationType: conversation?.type ?? "DIRECT",
    conversationName: surfaceName(conversation),
    kind,
    joining: false,
  });
  let media: AcquiredMedia;
  try {
    media = await acquireMedia(kind);
  } catch (err) {
    setMediaError(mediaErrorMessage(err)); // nothing emitted — the server never learns of a call with no media
    return;
  }
  let state = getCallState();
  if (state.phase !== "outgoing" || state.conversationId !== conversationId) {
    stopTracks(media.stream); // surface closed while the permission prompt was up
    return;
  }
  setLocalStream(media.stream, media.cameraless);
  const ack = await emitAck<CallInviteOk>("call:invite", { conversationId, kind });
  state = getCallState();
  if (state.phase !== "outgoing" || state.conversationId !== conversationId) {
    if (ack?.ok) socketRef?.emit("call:cancel", { callId: ack.callId }); // bailed while the invite was in flight
    return;
  }
  if (!ack?.ok) {
    handleInviteFailure(ack ?? null, conversation);
    return;
  }
  iceServers = ack.iceServers;
  setCallId(ack.callId); // phase stays "outgoing" until the first participant-joined
}

function handleInviteFailure(ack: CallFailAck | null, conversation: ConversationSummary | undefined): void {
  if (ack?.code === "CALL_ACTIVE" && ack.callId) {
    // Call-level glare: this conversation already has a live call — answer it
    // with the media we already hold (DM crossing-invites; group becomes a join).
    void joinExisting(ack.callId);
    return;
  }
  const name = counterpartName(conversation);
  switch (ack?.code) {
    case "OFFLINE":
      // Doc-mandated presence leak, accepted (call.md §8).
      toast.info(conversation?.type === "GROUP" ? "No one is online right now" : `${name} is offline`);
      break;
    case "PEER_BUSY":
      toast.info(`${name} is on another call`);
      break;
    case "SELF_BUSY":
      toast.error("You're already in a call");
      break;
    case "RATE_LIMITED":
      toast.error(ack.error || "Too many calls — try again later");
      break;
    default:
      toast.error(ack?.error || "Couldn't start the call");
  }
  teardown();
}

async function joinExisting(callId: string): Promise<void> {
  setCallId(callId);
  // call:accept works for both cases — accept-while-ONGOING is a join server-side.
  await joinById(callId, "call:accept", false);
}

export async function acceptCall(): Promise<void> {
  const state = getCallState();
  if (state.phase !== "incoming" || !state.callId) return;
  if (accepting) return; // a double click must not double-emit call:accept
  accepting = true;
  try {
    const { callId, kind } = state;
    primeAudioContext(); // the accept click is a gesture — unlock audio here, not hopefully earlier
    stopRingtone();
    clearRingFailsafe();
    let media: AcquiredMedia;
    try {
      media = await acquireMedia(kind ?? "AUDIO");
    } catch (err) {
      // A reject, not an error ack — indistinguishable from a decline by design.
      void emitAck("call:reject", { callId });
      toast.error(mediaErrorMessage(err), { toastId: callToastId(callId) });
      teardown();
      return;
    }
    const current = getCallState();
    if (current.phase !== "incoming" || current.callId !== callId) {
      stopTracks(media.stream); // the ring ended while the permission prompt was up
      return;
    }
    setLocalStream(media.stream, media.cameraless);
    await joinById(callId, "call:accept", true);
  } finally {
    accepting = false;
  }
}

export function declineCall(): void {
  const state = getCallState();
  if (state.phase !== "incoming" || !state.callId) return;
  void emitAck("call:reject", { callId: state.callId });
  teardown();
}

export function joinCall(conversationId: string): void {
  const entry = getOngoingCall(conversationId);
  if (!entry) return;
  void beginJoin(entry.callId, conversationId, entry.kind);
}

async function beginJoin(callId: string, conversationId: string, kind: CallKind): Promise<void> {
  if (getCallPhase() !== "idle") return;
  primeAudioContext();
  const conversation = findConversation(conversationId);
  beginOutgoing({
    conversationId,
    conversationType: conversation?.type ?? "GROUP",
    conversationName: surfaceName(conversation),
    kind,
    joining: true,
  });
  let media: AcquiredMedia;
  try {
    media = await acquireMedia(kind);
  } catch (err) {
    setMediaError(mediaErrorMessage(err));
    return;
  }
  const state = getCallState();
  if (state.phase !== "outgoing" || state.conversationId !== conversationId) {
    stopTracks(media.stream);
    return;
  }
  setLocalStream(media.stream, media.cameraless);
  setCallId(callId);
  await joinById(callId, "call:join", false);
}

async function joinById(callId: string, event: "call:accept" | "call:join", wasIncoming: boolean): Promise<void> {
  pendingJoinCallId = callId;
  let ack: CallAck<CallJoinOk> | null;
  try {
    ack = await emitAck<CallJoinOk>(event, { callId });
  } finally {
    pendingJoinCallId = null;
  }
  const state = getCallState();
  if (state.callId !== callId || state.phase === "idle") {
    // Torn down while the ack was in flight — make sure the server agrees.
    if (ack?.ok) socketRef?.emit("call:leave", { callId });
    return;
  }
  if (!ack) {
    toast.error("Couldn't connect the call", { toastId: callToastId(callId) });
    teardown();
    return;
  }
  if (!ack.ok) {
    if (ack.code === "NOT_FOUND" || ack.code === "CALL_ENDED") {
      toast.info(wasIncoming ? "Call ended before you answered" : "Call ended", { toastId: callToastId(callId) });
    } else if (ack.code === "CALL_FULL") {
      toast.info("This call is full", { toastId: callToastId(callId) });
    } else if (ack.code === "SELF_BUSY") {
      toast.error("You're already in a call", { toastId: callToastId(callId) });
    } else {
      toast.error(ack.error || "Couldn't join the call", { toastId: callToastId(callId) });
    }
    teardown();
    return;
  }
  applyJoinOk(ack);
}

function withoutSelf(users: CallUser[]): CallUser[] {
  const me = depsRef?.getViewerId();
  return me == null ? users : users.filter((u) => u.id !== me);
}

function applyJoinOk(ack: CallJoinOk): void {
  iceServers = ack.iceServers;
  syncParticipants(withoutSelf(ack.participants));
  setActive({ callId: ack.callId, conversationId: ack.conversationId, kind: ack.kind });
  // NO eager peers — our participant-joined broadcast makes incumbents offer
  // (call.md §2.4); the windows just bound how long we wait for those offers.
  for (const user of ack.participants) armConnectTimer(user.id);
}

export function hangUp(): void {
  const state = getCallState();
  if (state.phase === "idle") return;
  if (state.callId) {
    const event =
      state.phase === "outgoing"
        ? state.joining
          ? "call:leave" // a join-in-flight was never RINGING — cancel would be wrong
          : "call:cancel"
        : state.phase === "incoming"
          ? "call:reject"
          : "call:leave";
    void emitAck(event, { callId: state.callId });
  }
  teardown();
}

export function toggleMic(): void {
  const state = getCallState();
  if (!state.localStream) return;
  const micMuted = !state.micMuted;
  for (const track of state.localStream.getAudioTracks()) track.enabled = !micMuted;
  setSelfMute({ micMuted });
  emitMuteState();
}

export function toggleCamera(): void {
  const state = getCallState();
  if (!state.localStream || state.localStream.getVideoTracks().length === 0) return;
  const cameraOff = !state.cameraOff;
  for (const track of state.localStream.getVideoTracks()) track.enabled = !cameraOff;
  setSelfMute({ cameraOff });
  emitMuteState();
}

function emitMuteState(): void {
  const state = getCallState();
  if (!state.callId) return;
  socketRef?.emit("call:mute-state", { callId: state.callId, micMuted: state.micMuted, cameraOff: state.cameraOff });
}

// --- socket event handlers --------------------------------------------------

function onRing(payload: CallRingEvent): void {
  const state = getCallState();
  if (state.phase !== "idle") {
    if (state.callId === payload.callId) return;
    // Already in a call — a compact heads-up, never a modal takeover or ringtone.
    toast.info(
      `Incoming ${payload.kind === "VIDEO" ? "video" : "audio"} call from ${displayName(payload.caller)}`,
      { toastId: callToastId(payload.callId), autoClose: payload.ringTimeoutMs },
    );
    return;
  }
  setIncoming({
    callId: payload.callId,
    conversationId: payload.conversationId,
    conversationType: payload.conversationType,
    conversationName: payload.conversationName,
    kind: payload.kind,
    caller: payload.caller,
  });
  // The modal always shows; only the SOUND is gated on prefs and mute.
  const prefs = getNotificationPrefs();
  const conversation = findConversation(payload.conversationId);
  if (prefs.sound && prefs.ringtone && !isMuted(conversation?.mutedUntil ?? null, Date.now())) startRingtone();
  clearRingFailsafe();
  ringFailsafe = setTimeout(() => {
    ringFailsafe = null;
    const current = getCallState();
    if (current.phase === "incoming" && current.callId === payload.callId) teardown();
  }, payload.ringTimeoutMs + RING_FAILSAFE_EXTRA_MS);
}

function onCallStarted(payload: CallStartedEvent): void {
  // Seeds the group join banner; count starts at 1 (the caller).
  addOngoing({
    callId: payload.callId,
    conversationId: payload.conversationId,
    kind: payload.kind,
    participantCount: 1,
  });
}

function onParticipantJoined(payload: CallParticipantJoinedEvent): void {
  const { callId, user, joinedUserIds } = payload;
  setOngoingCount(callId, joinedUserIds.length);
  const me = depsRef?.getViewerId();
  const state = getCallState();
  if (user.id === me) {
    // Another tab of ours answered — this one stands down. While our OWN
    // accept ack is still in flight this is just our echo, not another tab.
    if (state.phase === "incoming" && state.callId === callId && pendingJoinCallId !== callId) teardown();
    toast.dismiss(callToastId(callId));
    return;
  }
  if (state.callId !== callId) return;
  // Only an already-joined session is an incumbent. If our own join hasn't been
  // processed yet we're absent from joinedUserIds — their side offers to us.
  if (me == null || !joinedUserIds.includes(me)) return;
  if (state.phase === "outgoing") setActive({}); // the first join answers the ring
  else if (state.phase !== "active" && state.phase !== "reconnecting") return;
  upsertParticipant(user);
  // Newest session wins the mesh: drop any stale peer and offer fresh (re-peer rule).
  const stale = peers.get(user.id);
  if (stale) {
    peers.delete(user.id);
    stale.peer.destroy();
  }
  clearConnectTimer(user.id); // a fresh joiner gets a fresh window
  createPeer(user.id, true);
  armConnectTimer(user.id);
}

function onParticipantLeft(payload: CallParticipantLeftEvent): void {
  const { callId, userId, joinedUserIds } = payload;
  setOngoingCount(callId, joinedUserIds.length);
  const state = getCallState();
  if (state.callId !== callId) return;
  if (userId === depsRef?.getViewerId()) {
    // Our own leave already tore down before this echo — reaching here means a
    // server-side force-leave (removed from the conversation).
    teardown();
    toast.info("You were removed from the call", { toastId: callToastId(callId) });
    return;
  }
  const entry = peers.get(userId);
  if (entry) {
    peers.delete(userId);
    entry.peer.destroy();
  }
  clearConnectTimer(userId);
  removeParticipant(userId);
}

function onCallEnded(payload: CallEndedEvent): void {
  removeOngoing(payload.callId);
  toast.dismiss(callToastId(payload.callId));
  const state = getCallState();
  if (state.callId !== payload.callId) return;
  const { phase, joining } = state;
  teardown();
  if (phase === "incoming") return; // ring dismissed; the CALL bubble tells the story
  if (phase === "outgoing" && !joining) {
    toast.info(payload.status === "REJECTED" ? "Call declined" : "No answer", {
      toastId: callToastId(payload.callId),
    });
    return;
  }
  toast.info("Call ended", { toastId: callToastId(payload.callId) });
}

function dismissRing(callId: string): void {
  toast.dismiss(callToastId(callId));
  const state = getCallState();
  if (state.phase === "incoming" && state.callId === callId) teardown();
}

function onRingCancelled(payload: CallRingCancelledEvent): void {
  dismissRing(payload.callId);
}

function onRingHandled(payload: CallRingHandledEvent): void {
  dismissRing(payload.callId);
}

function onRtcSignal(payload: RtcSignalEvent): void {
  const { callId, from, data } = payload;
  const state = getCallState();
  if (state.callId !== callId) return; // unknown call — a buffered/stale emit, ignore
  if (state.phase !== "active" && state.phase !== "reconnecting") return;
  const isOffer = !("candidate" in data) && data.type === "offer";
  const existing = peers.get(from);
  if (existing) {
    // Fixed roles mean a pc only ever receives ONE offer — ANY inbound offer
    // for an existing entry denotes a fresh remote pc, established or not.
    if (isOffer) {
      peers.delete(from);
      existing.peer.destroy();
      clearConnectTimer(from);
      setParticipantConnection(from, "connecting");
      const entry = createPeer(from, false);
      armConnectTimer(from);
      if (entry) void entry.peer.signal(data);
      return;
    }
    void existing.peer.signal(data);
    return;
  }
  if (!isOffer) return; // a candidate for a peer we never made — stale epoch, drop
  if (!state.participants.some((p) => p.user.id === from)) return; // not a joined participant we know
  // The lazy non-initiator half of the offer rule — created on the FIRST inbound offer.
  const entry = createPeer(from, false);
  armConnectTimer(from);
  if (entry) void entry.peer.signal(data);
}

function onMuteState(payload: CallMuteStateEvent): void {
  if (getCallState().callId !== payload.callId) return;
  setParticipantMute(payload.userId, payload.micMuted, payload.cameraOff);
}

function onConnect(): void {
  resync();
}

function onDisconnect(reason: string): void {
  if (reason === "io client disconnect") {
    // Sign-out / release — the camera light dies NOW, not on some later event.
    teardown();
    return;
  }
  // P2P media outlives the signaling socket; server grace + resync cover the rest.
  if (getCallPhase() === "active") setPhase("reconnecting");
}

// --- resync -----------------------------------------------------------------

function resync(): void {
  const socket = socketRef;
  if (!socket) return;
  socket.timeout(ACK_TIMEOUT_MS).emit("call:state", {}, (timeoutError: Error | null, response?: CallAck<CallStateOk>) => {
    if (timeoutError || !response?.ok) return;
    replaceOngoing(response.ongoing);
    const state = getCallState();
    const self = response.self;
    const inCall =
      state.callId !== null &&
      (state.phase === "outgoing" || state.phase === "active" || state.phase === "reconnecting");
    if (!self) {
      if (inCall) {
        const callId = state.callId;
        teardown();
        toast.info("Call ended", callId ? { toastId: callToastId(callId) } : undefined);
      }
      return;
    }
    if (inCall && self.callId === state.callId) {
      iceServers = self.iceServers;
      syncParticipants(withoutSelf(self.participants), { prune: true });
      if (state.phase === "reconnecting") setPhase("active");
      if (state.phase !== "outgoing") {
        // Re-join re-fires participant-joined server-side — incumbents re-offer
        // to this fresh session (the rejoin-re-peer rule).
        void joinById(self.callId, "call:join", false);
      }
      return;
    }
    if (inCall) {
      // Server says we're in a DIFFERENT call (another tab won) — follow it.
      teardown();
      offerRejoin(self);
      return;
    }
    if (state.phase === "idle") offerRejoin(self); // refresh mid-call
  });
}

function offerRejoin(self: CallStateSelf): void {
  const id = callToastId(self.callId);
  let rejoined = false;
  toast.info("You're still in a call — click to rejoin", {
    toastId: id,
    autoClose: false,
    onClick: () => {
      rejoined = true;
      toast.dismiss(id);
      void beginJoin(self.callId, self.conversationId, self.kind);
    },
    // Dismissing the offer IS the answer: leave, or the server keeps this user
    // joined forever and a group call can never reach zero and end.
    onClose: () => {
      if (!rejoined) socketRef?.emit("call:leave", { callId: self.callId });
    },
  });
}

// --- lifecycle --------------------------------------------------------------

export function attachCallSession(socket: ChatSocket, deps: CallSessionDeps): () => void {
  detachCurrent?.(); // one live session per tab
  socketRef = socket;
  depsRef = deps;
  socket.on("connect", onConnect);
  socket.on("disconnect", onDisconnect);
  socket.on("call:ring", onRing);
  socket.on("call:started", onCallStarted);
  socket.on("call:participant-joined", onParticipantJoined);
  socket.on("call:participant-left", onParticipantLeft);
  socket.on("call:ended", onCallEnded);
  socket.on("call:ring-cancelled", onRingCancelled);
  socket.on("call:ring-handled", onRingHandled);
  socket.on("rtc:signal", onRtcSignal);
  socket.on("call:mute-state", onMuteState);
  if (socket.connected) resync(); // attach can happen after the socket is already up
  const detach = () => {
    socket.off("connect", onConnect);
    socket.off("disconnect", onDisconnect);
    socket.off("call:ring", onRing);
    socket.off("call:started", onCallStarted);
    socket.off("call:participant-joined", onParticipantJoined);
    socket.off("call:participant-left", onParticipantLeft);
    socket.off("call:ended", onCallEnded);
    socket.off("call:ring-cancelled", onRingCancelled);
    socket.off("call:ring-handled", onRingHandled);
    socket.off("rtc:signal", onRtcSignal);
    socket.off("call:mute-state", onMuteState);
    // A real unmount is sign-out territory; StrictMode's immediate cleanup
    // finds phase idle and this is a no-op.
    if (getCallPhase() !== "idle") teardown();
    if (socketRef === socket) {
      socketRef = null;
      depsRef = null;
    }
    if (detachCurrent === detach) detachCurrent = null;
  };
  detachCurrent = detach;
  return detach;
}
