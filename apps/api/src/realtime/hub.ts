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
import type { Logger } from '../platform/logging';
import { resolveSession } from '../modules/auth/sessions';
import { sessionTokenFrom } from '../ingress/http/cookies';
import type { SocketIdentity } from './router';

/** How a connection is reached and ended. The transport supplies both. */
export interface Connection {
  /**
   * The transport's answer: bytes written, `-1` when queued behind earlier
   * frames, or `0` when the frame was **dropped** — Bun's, measured (#197).
   */
  readonly send: (payload: string) => number;
  /** Bytes queued for this connection and not yet written to the network. */
  readonly buffered: () => number;
  readonly close: (code: number, reason: string) => void;
}

/**
 * How far a connection may fall behind before it is closed to resync.
 *
 * Measured: with nothing reading, the transport queues 16 MB per connection and
 * then **drops** frames while the connection stays open — the client misses
 * messages and, never disconnected, never replays them. Closing first turns that
 * into a reconnect and a replay from the cursor, so nothing is lost silently.
 *
 * It must exceed the largest burst a healthy connection receives at once, or a
 * fast reader would be closed by its own replay and loop: that is the replay's
 * byte budget, and a test binds the two (`REPLAY_BYTES_MAX` in `router.ts`).
 */
export const OUTBOUND_HIGH_WATER_MARK = 4 * 1024 * 1024;

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
  /** Closes every connection with this code — what a shutdown does to tell clients to come back. */
  closeAll: (code: number, reason: string) => void;
  /** What the bus delivers through. */
  deliver: (socketId: string, frame: ServerFrame) => void;
  /**
   * From now until `reply`, live frames for this connection are kept instead of
   * written, so a subscription can be made **before** its replay is read without
   * the live stream getting ahead of the acknowledgement (`ARCHITECTURE.md` §5.4).
   */
  hold: (socketId: string) => void;
  /**
   * Writes what a client frame is answered with, then the live frames kept since
   * `hold` — minus any message the replay already carried, by id. Releases the
   * hold whether or not there was one.
   */
  reply: (socketId: string, replies: readonly ServerFrame[]) => void;
  /** Whether the connection is still held: false once it has closed. */
  isOpen: (socketId: string) => boolean;
  readonly size: () => number;
}

/**
 * The most live frames kept for one connection while its subscription replays. A
 * replay is milliseconds; a channel that produces this many in that time is
 * outrunning the connection, which is what a resync is for.
 */
export const HELD_FRAMES_MAX = 1_000;

interface Held {
  readonly connection: Connection;
  readonly identity: Promise<SocketIdentity | undefined>;
  cancelExpiry?: () => void;
  /** Present while a subscription is being replayed. */
  holding?: ServerFrame[] | undefined;
}

export interface HubOptions {
  readonly log: Logger;
  readonly timers?: Timers;
}

export const createSocketHub = (
  database: Executor,
  clock: Clock,
  { log, timers = systemTimers }: HubOptions,
): SocketHub => {
  const held = new Map<string, Held>();

  const write = (socketId: string, socket: Held, frame: ServerFrame): void => {
    const written = socket.connection.send(JSON.stringify(frame));
    if (frame.event === 'SESSION_ENDED') {
      socket.connection.close(CLOSE_CODES.SESSION_ENDED, frame.data.reason);
      return;
    }
    // A dropped frame, or a queue past the mark: this connection can no longer be
    // trusted to have everything, so it is told to reconnect and replay rather
    // than left open with a gap it cannot see (`ARCHITECTURE.md` §5.5).
    const buffered = socket.connection.buffered();
    if (written === 0 || buffered > OUTBOUND_HIGH_WATER_MARK) {
      log.warn('socket fell behind and was closed to resync', {
        socketId,
        dropped: written === 0,
        buffered,
      });
      socket.connection.close(CLOSE_CODES.RESYNC, 'resync');
    }
  };

  const deliver = (socketId: string, frame: ServerFrame): void => {
    const socket = held.get(socketId);
    // A frame for a connection that has gone is dropped, not queued. Delivery is
    // best-effort by design: what a client missed it asks for on reconnect, by
    // keyset (`ARCHITECTURE.md` §5.4).
    if (socket === undefined) return;
    // The end of a session is never kept waiting behind a replay.
    if (socket.holding !== undefined && frame.event !== 'SESSION_ENDED') {
      if (socket.holding.length >= HELD_FRAMES_MAX) {
        log.warn('socket fell behind during a replay and was closed to resync', { socketId });
        socket.holding = undefined;
        socket.connection.close(CLOSE_CODES.RESYNC, 'resync');
        return;
      }
      socket.holding.push(frame);
      return;
    }
    write(socketId, socket, frame);
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

    closeAll: (code: number, reason: string): void => {
      for (const socket of held.values()) socket.connection.close(code, reason);
    },

    deliver,

    hold: (socketId: string): void => {
      const socket = held.get(socketId);
      if (socket !== undefined) socket.holding = [];
    },

    reply: (socketId: string, replies: readonly ServerFrame[]): void => {
      const socket = held.get(socketId);
      if (socket === undefined) return;
      const kept = socket.holding ?? [];
      socket.holding = undefined;
      const replayed = new Set<string>();
      for (const reply of replies) {
        if (reply.event === 'MESSAGE_CREATED') replayed.add(reply.data.id);
        write(socketId, socket, reply);
      }
      // Live frames that arrived while the replay was read: a message committed
      // after the subscription and before the read is in both, and is sent once.
      for (const live of kept) {
        if (live.event === 'MESSAGE_CREATED' && replayed.has(live.data.id)) continue;
        // A write above may have closed the connection; stop writing to it.
        if (!held.has(socketId)) return;
        write(socketId, socket, live);
      }
    },

    isOpen: (socketId: string): boolean => held.has(socketId),

    size: (): number => held.size,
  };
};
