/**
 * The socket hub: which connection belongs to whom, how a frame reaches one, and
 * when one has to end.
 *
 * **It never touches the database for anything but identity, and never touches a
 * service.** Services publish to the bus; the hub subscribes and delivers. That
 * separation is what makes a later move to a shared bus a one-file change (D-7).
 *
 * **A connection lives exactly as long as its session.** Identity is resolved
 * once, when the socket opens, and remembered — a per-frame session read would
 * put a query on the hottest path to answer a question whose answer changes only
 * at two moments. Those two moments end the connection instead:
 *
 * - **revocation** arrives as a `SESSION_ENDED` frame on the session's topic,
 *   published by sign-out, so it reaches the socket on whichever node holds it;
 * - **expiry** is a timer set from the session's `expires_at`.
 *
 * Either way the frame is delivered first, so the client knows why, and the
 * connection is closed with `CLOSE_CODES.SESSION_ENDED` (#194).
 */
import { CLOSE_CODES, type ServerFrame } from '@purlay/types';
import type { Executor } from '@purlay/db';
import type { Clock } from '../platform/clock';
import { resolveSession } from '../modules/auth/sessions';
import { sessionTokenFrom } from '../ingress/http/cookies';
import type { SocketIdentity } from './router';

/** How a connection is reached and ended. The transport supplies both. */
export interface Connection {
  readonly send: (payload: string) => void;
  readonly close: (code: number, reason: string) => void;
}

/** A timer, injected so a thirty-day expiry can be tested without thirty days. */
export interface Timers {
  readonly set: (callback: () => void, ms: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export const systemTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * The longest single delay a JavaScript timer honours: 2³¹−1 ms, about 24.8 days.
 * A longer one fires **immediately** — and the default session lives thirty days,
 * so an unchunked timer would end every connection the moment it opened.
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Calls `callback` after `ms`, however long that is, by chaining timers no longer
 * than `MAX_TIMER_MS`. Returns how to cancel whichever link is pending.
 */
export const after = (timers: Timers, ms: number, callback: () => void): (() => void) => {
  let handle: unknown;
  const step = (remaining: number): void => {
    if (remaining <= MAX_TIMER_MS) {
      handle = timers.set(callback, Math.max(0, remaining));
      return;
    }
    handle = timers.set(() => {
      step(remaining - MAX_TIMER_MS);
    }, MAX_TIMER_MS);
  };
  step(ms);
  return () => {
    timers.clear(handle);
  };
};

export interface SocketHub {
  /** Registers the connection and resolves who is on it; `undefined` if nobody is. */
  opened: (
    socketId: string,
    connection: Connection,
    request: Request,
  ) => Promise<SocketIdentity | undefined>;
  /** Who is on this connection, as resolved when it opened. */
  identity: (socketId: string) => Promise<SocketIdentity | undefined>;
  closed: (socketId: string) => void;
  /** What the bus delivers through. */
  deliver: (socketId: string, frame: ServerFrame) => void;
  readonly size: () => number;
}

interface Held {
  readonly connection: Connection;
  readonly identity: Promise<SocketIdentity | undefined>;
  cancelExpiry?: () => void;
}

export const createSocketHub = (
  database: Executor,
  clock: Clock,
  timers: Timers = systemTimers,
): SocketHub => {
  const held = new Map<string, Held>();

  const deliver = (socketId: string, frame: ServerFrame): void => {
    const socket = held.get(socketId);
    // A frame for a connection that has gone is dropped, not queued. Delivery is
    // best-effort by design: what a client missed it asks for on reconnect, by
    // keyset (`ARCHITECTURE.md` §5.4).
    if (socket === undefined) return;
    socket.connection.send(JSON.stringify(frame));
    if (frame.event === 'SESSION_ENDED') {
      socket.connection.close(CLOSE_CODES.SESSION_ENDED, frame.data.reason);
    }
  };

  const resolve = async (
    socketId: string,
    request: Request,
  ): Promise<SocketIdentity | undefined> => {
    const token = sessionTokenFrom(request.headers.get('cookie'));
    const owner = token === undefined ? undefined : await resolveSession(database, clock, token);
    return owner === undefined
      ? undefined
      : { socketId, userId: owner.userId, sessionId: owner.sessionId, expiresAt: owner.expiresAt };
  };

  return {
    opened: async (socketId, connection, request): Promise<SocketIdentity | undefined> => {
      // The promise is held, not its result, so two frames racing the first
      // resolution share one read and one timer.
      const pending = resolve(socketId, request);
      const entry: Held = { connection, identity: pending };
      held.set(socketId, entry);

      const identity = await pending;
      // Closed while its identity was being resolved: arm nothing for a
      // connection that is gone, or its timer and topic outlive it.
      if (held.get(socketId) !== entry) return undefined;
      if (identity === undefined) {
        // Admission checked the session before the socket was bound; it ended in
        // between. Nothing on this connection can be answered.
        connection.close(CLOSE_CODES.SESSION_ENDED, 'signed-out');
        return undefined;
      }
      entry.cancelExpiry = after(
        timers,
        identity.expiresAt.getTime() - clock.now().getTime(),
        () => {
          deliver(socketId, {
            event: 'SESSION_ENDED',
            data: { reason: 'expired' },
            ts: clock.now().getTime(),
          });
        },
      );
      return identity;
    },

    identity: async (socketId: string): Promise<SocketIdentity | undefined> =>
      await (held.get(socketId)?.identity ?? Promise.resolve(undefined)),

    closed: (socketId: string): void => {
      held.get(socketId)?.cancelExpiry?.();
      held.delete(socketId);
    },

    deliver,

    size: (): number => held.size,
  };
};
