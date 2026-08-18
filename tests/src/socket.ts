import { io as connect, type Socket } from "socket.io-client";
import { config } from "./env";
import type { ApiClient } from "./api";

const openSockets: Socket[] = [];

export type SocketSession = { socket: Socket; userId: string; bootId: string };

/**
 * Login happened over HTTP first; the socket handshake reuses that cookie jar.
 * No Origin header on purpose — the server's allowRequest deliberately admits
 * origin-less clients (it exists for exactly this harness); the cookie is the
 * credential.
 */
export async function connectAs(api: ApiClient): Promise<SocketSession> {
  const socket = connect(config.socketUrl, {
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    extraHeaders: { cookie: api.cookieHeader() },
  });
  openSockets.push(socket);
  const ready = await new Promise<{ userId: string; bootId: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("session:ready never arrived")), 10_000);
    socket.once("session:ready", (payload: { userId: string; bootId: string }) => {
      clearTimeout(timer);
      resolve(payload);
    });
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { socket, ...ready };
}

/** Expect the handshake itself to be rejected; resolves with the error. */
export async function expectConnectError(api: ApiClient | null): Promise<Error & { data?: { code?: string } }> {
  const socket = connect(config.socketUrl, {
    forceNew: true,
    reconnection: false,
    timeout: 10_000,
    extraHeaders: api ? { cookie: api.cookieHeader() } : {},
  });
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("expected connect_error, got neither")), 10_000);
    socket.once("connect_error", (error: Error) => {
      clearTimeout(timer);
      resolve(error);
    });
    socket.once("session:ready", () => {
      clearTimeout(timer);
      reject(new Error("expected connect_error, but the handshake succeeded"));
    });
  });
}

/** Promise for the next event matching the predicate. Register BEFORE acting. */
export function waitFor<T = unknown>(
  socket: Socket,
  event: string,
  predicate: (payload: T) => boolean = () => true,
  timeoutMs = 8_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timed out waiting for ${event}`));
    }, timeoutMs);
    function handler(payload: T) {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/** Asserts an event does NOT arrive within the window (privacy pins). */
export async function expectSilence(
  socket: Socket,
  event: string,
  ms = 600,
  predicate: (payload: unknown) => boolean = () => true,
): Promise<void> {
  let heard: unknown | undefined;
  function handler(payload: unknown) {
    if (predicate(payload)) heard = payload;
  }
  socket.on(event, handler);
  await new Promise((resolve) => setTimeout(resolve, ms));
  socket.off(event, handler);
  if (heard !== undefined) {
    throw new Error(`expected silence on ${event}, got ${JSON.stringify(heard)}`);
  }
}

/** The chat handlers use plain callback acks, promisified here. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function emitWithAck<T = any>(socket: Socket, event: string, payload: unknown, timeoutMs = 8_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), timeoutMs);
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

export function closeAllSockets(): void {
  for (const socket of openSockets.splice(0)) {
    if (socket.connected || socket.active) socket.disconnect();
  }
}
