import { io, type Socket } from "socket.io-client";

/**
 * The one shared socket per tab (Docs/chat/chat.md §2.1).
 *
 * Deliberately no "use client": this is a plain module with no React and
 * nothing running at import time. Adding the directive would create a boundary
 * for nothing — and per CLAUDE.md, *adding* one needlessly is the silent hazard.
 */

export type ChatSocket = Socket;

// Must be a literal process.env reference — Next only inlines literals.
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000";

type SocketRegistry = { socket: ChatSocket | null; refs: number; releaseTimer: ReturnType<typeof setTimeout> | null };

// Hung off globalThis rather than a module-level `let` so it also survives Fast
// Refresh re-evaluating this module in development.
const globalRef = globalThis as typeof globalThis & { __chatSocket?: SocketRegistry };
const registry: SocketRegistry = (globalRef.__chatSocket ??= { socket: null, refs: 0, releaseTimer: null });

// React 19 Strict Mode double-invokes effects in development, and Next 16
// enables Strict Mode by default. Disconnecting on the first cleanup and
// reconnecting on the second mount would churn a real TCP connection and re-run
// the server's session handshake, so the release is deferred: an immediate
// re-acquire cancels it, a genuine unmount lets it fire.
const RELEASE_DELAY_MS = 1000;

export function acquireSocket(): ChatSocket {
  if (registry.releaseTimer) {
    clearTimeout(registry.releaseTimer);
    registry.releaseTimer = null;
  }
  registry.refs += 1;
  registry.socket ??= io(SOCKET_URL, {
    // Mandatory. engine.io tries HTTP polling first, and a cross-origin XHR
    // only carries cookies in credentials mode — socket.io-client defaults
    // this to false, so without it the handshake arrives with no session
    // cookie at all and every connection is rejected. (Socket.IO's own docs
    // say withCredentials has no effect "on same-site requests", which is
    // misleading: the browser rule is same-ORIGIN, and :3000 -> :4000 is not.)
    withCredentials: true,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
    randomizationFactor: 0.5,
  });
  return registry.socket;
}

export function releaseSocket(): void {
  registry.refs = Math.max(0, registry.refs - 1);
  if (registry.refs > 0) return;
  registry.releaseTimer = setTimeout(() => {
    registry.releaseTimer = null;
    if (registry.refs > 0) return;
    registry.socket?.disconnect();
    registry.socket = null;
  }, RELEASE_DELAY_MS);
}

/** Hard teardown on sign-out — the next user must not inherit this connection. */
export function resetSocket(): void {
  if (registry.releaseTimer) {
    clearTimeout(registry.releaseTimer);
    registry.releaseTimer = null;
  }
  registry.refs = 0;
  registry.socket?.disconnect();
  registry.socket = null;
}
