import { io, type Socket } from 'socket.io-client';
import { API_BASE_URL } from '../config/env';

/**
 * The renderer's single Socket.IO connection.
 *
 * OWNERSHIP - why this is not a module-level `io(...)` call:
 *
 * Importing this file must not open a socket. A module with connection side
 * effects connects during any import that happens to pull it in - a unit test,
 * a type-only cycle, a lazily loaded screen - and the timing is invisible at
 * the call site. Instead the connection is created on first *subscription*,
 * which is an explicit act by a component that actually wants realtime state.
 *
 * Exactly one socket exists per window. `socket` is created once and reused;
 * concurrent subscribers share it. It is deliberately never torn down on
 * component unmount: the connection is app-scoped, not component-scoped, and
 * cycling it on every mount would fight React StrictMode and produce a stream
 * of pointless connect/disconnect pairs in the server log. It dies with the
 * window, which is exactly when the session ends.
 *
 * The base URL comes from the same preload bridge the API client uses, so
 * there is no second address to keep in sync. Socket.IO shares the server's
 * HTTP origin.
 */

export type RealtimeState =
  /** No subscriber yet - nothing has asked for a connection. */
  | 'idle'
  /** First connection attempt in flight. */
  | 'connecting'
  | 'connected'
  /** Lost the connection; Socket.IO is retrying. */
  | 'reconnecting'
  /** Gave up, or could not resolve where to connect. */
  | 'error';

export interface RealtimeSnapshot {
  readonly state: RealtimeState;
  readonly socketId: string | null;
  /** Safe, human-readable reason. Never a stack trace. */
  readonly lastError: string | null;
  /** Counts successful connections; a jump means the server restarted under us. */
  readonly connectCount: number;
}

let socket: Socket | null = null;
let creating: Promise<Socket> | null = null;

/**
 * Where the bearer token comes from - the auth store, joined once in
 * authStore.ts exactly as the API client is. The server refuses a socket that
 * does not present one.
 */
let getAuthToken: () => string | null = () => null;

export function setRealtimeAuthTokenGetter(getter: () => string | null): void {
  getAuthToken = getter;
}

/** How long to wait before asking again after the server refused or dropped us. */
const REFUSED_RETRY_MS = 3000;

/**
 * Domain-event subscribers, keyed by event name.
 *
 * Handlers are registered against this map rather than the socket directly,
 * because a component can subscribe before the connection exists (creation is
 * async) and must not miss events afterwards. Exactly ONE `socket.on` listener
 * is bound per event name however many components subscribe, so a screen that
 * mounts fifty table cards does not bind fifty listeners.
 */
const eventHandlers = new Map<string, Set<(payload: unknown) => void>>();
const boundEvents = new Set<string>();

function bindEvent(target: Socket, event: string): void {
  if (boundEvents.has(event)) return;
  boundEvents.add(event);
  target.on(event, (payload: unknown) => {
    // Copied before iterating: a handler that unsubscribes itself must not
    // mutate the set mid-iteration.
    for (const handler of [...(eventHandlers.get(event) ?? [])]) handler(payload);
  });
}

/**
 * The snapshot object is replaced, never mutated, so `useSyncExternalStore`
 * can compare by reference and re-render only on real change.
 */
let snapshot: RealtimeSnapshot = {
  state: 'idle',
  socketId: null,
  lastError: null,
  connectCount: 0,
};

const listeners = new Set<() => void>();

function update(patch: Partial<RealtimeSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

async function createSocket(): Promise<Socket> {
  const endpoint = new URL(API_BASE_URL, window.location.origin);
  const created = io(endpoint.origin, {
    path: `${endpoint.pathname.replace(/\/+$/, '')}/socket.io`,
    // Vercel routes WebSocket upgrades directly; polling would require sticky sessions.
    transports: ['websocket'],
    // Reconnect forever. A POS that silently stops receiving kitchen updates
    // after N failed attempts is worse than one that keeps trying quietly.
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    // Retry quickly, but back off so a long outage is not a spin loop.
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 5000,
    // A function, not a value: it is read on every (re)connect, so a socket
    // always presents whoever is signed in NOW rather than whoever was when
    // it was created.
    auth: (callback) => {
      callback({ token: getAuthToken() });
    },
  });

  /*
   * Socket.IO retries a dropped network on its own, but NOT a refusal by the
   * server's auth check or a disconnect the server initiated (a session that
   * ended). Those leave the socket inactive for good. Ask again later instead:
   * by then someone may have signed in, and if not, the next refusal is cheap.
   */
  const retryLater = (): void => {
    setTimeout(() => {
      if (socket === created && !created.active) created.connect();
    }, REFUSED_RETRY_MS);
  };

  created.on('connect', () => {
    update({
      state: 'connected',
      socketId: created.id ?? null,
      lastError: null,
      connectCount: snapshot.connectCount + 1,
    });
  });

  created.on('disconnect', (reason) => {
    update({
      // An explicit client disconnect is final; anything else is Socket.IO
      // already retrying in the background.
      state: reason === 'io client disconnect' ? 'idle' : 'reconnecting',
      socketId: null,
    });
    if (reason === 'io server disconnect') retryLater();
  });

  created.on('connect_error', (error: Error) => {
    update({ state: 'reconnecting', socketId: null, lastError: error.message });
    if (!created.active) retryLater();
  });

  return created;
}

/** Creates the connection if it does not exist yet. Safe to call repeatedly. */
export function ensureRealtimeConnection(): void {
  if (socket !== null || creating !== null) return;

  update({ state: 'connecting' });
  creating = createSocket()
    .then((created) => {
      socket = created;
      for (const event of eventHandlers.keys()) bindEvent(created, event);
      return created;
    })
    .catch((error: unknown) => {
      creating = null;
      throw error;
    });

  void creating.catch(() => {
    // State already recorded in createSocket; nothing further to do here, but
    // the rejection must be observed so it is not an unhandled promise.
  });
}

/** Subscribes to connection-state changes and opens the connection on demand. */
export function subscribeToRealtime(listener: () => void): () => void {
  listeners.add(listener);
  ensureRealtimeConnection();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Subscribes to a server-pushed domain event. Returns an unsubscribe function.
 *
 * Events are INVALIDATION SIGNALS, not state. A handler's job is to tell
 * TanStack Query that something it holds is stale, never to patch a cache from
 * the wire - two terminals applying different partial updates to their own
 * copies is how a POS starts disagreeing with itself. Refetching is cheap
 * against a server on the same machine, and it is always right.
 */
export function subscribeToRealtimeEvent<TPayload>(
  event: string,
  handler: (payload: TPayload) => void,
): () => void {
  const typed = handler as (payload: unknown) => void;
  let handlers = eventHandlers.get(event);
  if (handlers === undefined) {
    handlers = new Set();
    eventHandlers.set(event, handlers);
  }
  handlers.add(typed);

  ensureRealtimeConnection();
  if (socket !== null) bindEvent(socket, event);

  return () => {
    handlers.delete(typed);
  };
}

export function getRealtimeSnapshot(): RealtimeSnapshot {
  return snapshot;
}

/**
 * Reconnects with the current token. Called when the signed-in staff member
 * changes, so the socket never keeps listening on behalf of someone who left.
 * Does nothing before the first subscription opened a socket.
 */
export function refreshRealtimeAuth(): void {
  if (socket === null) return;
  socket.disconnect();
  if (getAuthToken() !== null) socket.connect();
}

/**
 * Closes the connection. Not used by any screen - the socket is meant to live
 * as long as the window - but kept so tests and future teardown paths have a
 * deliberate way to stop it.
 */
export function closeRealtimeConnection(): void {
  socket?.disconnect();
  socket = null;
  creating = null;
  // The handlers survive - subscribers still want their events - but the
  // bindings do not, so a fresh socket rebinds rather than silently skipping.
  boundEvents.clear();
  update({ state: 'idle', socketId: null });
}
