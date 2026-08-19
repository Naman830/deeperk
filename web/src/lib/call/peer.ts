import type { PeerSignalData } from "./types";

/**
 * In-repo replacement for simple-peer (unmaintained, needs Node polyfills Next
 * doesn't provide — Docs/call/call.md §1). Same one-event surface: construct
 * with a local stream, exchange opaque signal() payloads, get remote media back.
 *
 * Roles are fixed by the server's participant-joined broadcast — the incumbent
 * offers, the newcomer answers — so onnegotiationneeded is initiator-only and
 * there is no glare machinery, on purpose. Everything after destroy() is a
 * silent no-op.
 */

const GRACE_MS = 8000; // call.md §2.6 — self-heal window before the peer gives up

export type CallPeerOptions = {
  initiator: boolean;
  /** Shared across mesh peers and owned by the session — destroy() never stops it. */
  stream: MediaStream;
  iceServers: RTCIceServer[];
  onSignal: (data: PeerSignalData) => void;
  onStream: (stream: MediaStream) => void;
  onConnect: () => void;
  onClose: () => void;
};

export class CallPeer {
  readonly initiator: boolean;
  private readonly opts: CallPeerOptions;
  private readonly pc: RTCPeerConnection;
  private closed = false;
  private makingOffer = false;
  private pending: RTCIceCandidateInit[] = [];
  private remoteStreamId: string | null = null;
  // The 8s grace is a deadline timestamp, not a bare timer — background tabs
  // throttle timers, so visibilitychange re-checks it on return.
  private graceDeadline: number | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: CallPeerOptions) {
    this.opts = opts;
    this.initiator = opts.initiator;
    this.pc = new RTCPeerConnection({ iceServers: opts.iceServers });
    for (const track of opts.stream.getTracks()) this.pc.addTrack(track, opts.stream);
    if (opts.initiator) this.pc.onnegotiationneeded = () => void this.negotiate();
    this.pc.onicecandidate = (event) => {
      // Trickle: each candidate rides its own signal instead of waiting for gathering.
      if (event.candidate && !this.closed) this.opts.onSignal({ candidate: event.candidate.toJSON() });
    };
    this.pc.ontrack = (event) => {
      const stream = event.streams[0];
      // One onStream per remote stream, not one per track (audio + video arrive separately).
      if (!stream || this.closed || this.remoteStreamId === stream.id) return;
      this.remoteStreamId = stream.id;
      this.opts.onStream(stream);
    };
    this.pc.onconnectionstatechange = () => this.handleConnectionState();
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** True once a remote description landed — how the session tells a fresh
   *  answerer awaiting its first offer from an established peer to replace. */
  get hasRemoteDescription(): boolean {
    return !this.closed && this.pc.remoteDescription !== null;
  }

  /** Feed a payload from the other side's onSignal, verbatim. */
  async signal(data: PeerSignalData): Promise<void> {
    if (this.closed) return;
    try {
      if ("candidate" in data) {
        // Candidates can beat the offer under long-polling — queue until the
        // remote description exists, then flush.
        if (this.pc.remoteDescription === null) {
          this.pending.push(data.candidate);
          return;
        }
        await this.pc.addIceCandidate(data.candidate);
        return;
      }
      await this.pc.setRemoteDescription(data);
      if (data.type === "offer") {
        const answer = await this.pc.createAnswer();
        if (this.closed) return;
        await this.pc.setLocalDescription(answer);
        this.sendLocalDescription();
      }
      const queued = this.pending;
      this.pending = [];
      for (const candidate of queued) {
        if (this.closed) return;
        await this.pc.addIceCandidate(candidate);
      }
    } catch {
      // Late/stale signals from a torn-down epoch are noise, not errors.
    }
  }

  /** Idempotent. Closes the connection; local tracks stay live — the session owns them. */
  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearGrace();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    try {
      this.pc.close();
    } catch {
      // Already closed.
    }
    this.opts.onClose();
  }

  private async negotiate(): Promise<void> {
    if (this.closed || this.makingOffer) return;
    this.makingOffer = true;
    try {
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      this.sendLocalDescription();
    } catch {
      // Destroyed mid-negotiation.
    } finally {
      this.makingOffer = false;
    }
  }

  private sendLocalDescription(): void {
    const local = this.pc.localDescription;
    if (!local || this.closed) return;
    this.opts.onSignal({ type: local.type as "offer" | "answer", sdp: local.sdp });
  }

  private handleConnectionState(): void {
    if (this.closed) return;
    switch (this.pc.connectionState) {
      case "connected":
        this.clearGrace();
        this.opts.onConnect();
        break;
      case "disconnected":
        this.startGrace(); // often self-heals — give ICE its §2.6 window
        break;
      case "failed":
      case "closed":
        this.destroy();
        break;
    }
  }

  private startGrace(): void {
    if (this.graceDeadline !== null) return;
    this.graceDeadline = Date.now() + GRACE_MS;
    this.armGrace();
  }

  private armGrace(): void {
    if (this.graceTimer !== null) clearTimeout(this.graceTimer);
    const remaining = (this.graceDeadline ?? 0) - Date.now();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.checkGrace();
    }, Math.max(0, remaining));
  }

  private checkGrace(): void {
    if (this.closed || this.graceDeadline === null) return;
    if (Date.now() >= this.graceDeadline) this.destroy();
    else this.armGrace();
  }

  private clearGrace(): void {
    this.graceDeadline = null;
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible" && this.graceDeadline !== null) this.checkGrace();
  };
}
