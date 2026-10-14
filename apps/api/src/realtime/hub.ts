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
import { sessionFromCookie } from '../modules/auth/sessions';
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
 * byte budget, and a test binds the two (`REPLAY_BYTES_MAX` in `modules/messages/replay.ts`).
 */
export const OUTBOUND_HIGH_WATER_MARK = 4 * 1024 * 1024;

/**
 * A timer, injected so a thirty-day expiry can be tested without thirty days.
 *
 * `clear` is a method so a timer whose handle is more specific than `unknown`
 * (the runtime's) is accepted where any is: the handle only ever goes back to the
 * `Timers` that made it.
 */
export interface Timers<Handle = unknown> {
  set(callback: () => void, ms: number): Handle;
  clear(handle: Handle): void;
}

const runtimeTimers: Timers<ReturnType<typeof setTimeout>> = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => {
    clearTimeout(handle);
  },
};

export const systemTimers: Timers = runtimeTimers;

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
export const after = <Handle>(
  timers: Timers<Handle>,
  ms: number,
  callback: () => void,
): (() => void) => {
  let handle: Handle;
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
  /**
   * Forgets frames kept for this connection that belong to these channels — what a
   * subscription that was refused, after subscribing first, must not let through.
   */
  drop: (socketId: string, channelIds: readonly string[]) => void;
  /**
   * Runs one client frame's work after every earlier frame of this connection has
   * finished. The framework starts handlers as frames arrive and does not wait for
   * the last, so without this a slow `SUBSCRIBE` is overtaken by the `UNSUBSCRIBE`
   * sent after it, and a continuation outlives the close that should have ended it.
   * A queue past `FRAME_QUEUE_MAX` closes the connection; work still queued when it
   * closes is dropped.
   */
  enqueue: (socketId: string, work: () => Promise<void>) => void;
  /** Resolves when no queued work is running — what a drain waits for before closing the pool. */
  settled: () => Promise<void>;
  readonly size: () => number;
  /** How many open connections this user holds, whose identity has been resolved. */
  readonly connectionsOf: (userId: string) => number;
}

/**
 * How many frames of one connection may wait behind the one being handled. Above
 * the rate limiter's burst, so a connection within its budget never meets it.
 */
export const FRAME_QUEUE_MAX = 32;

/**
 * The most live frames kept for one connection while its subscription replays. A
 * replay is milliseconds; a channel that produces this many in that time is
 * outrunning the connection, which is what a resync is for.
 */
export const HELD_FRAMES_MAX = 1_000;

interface Held {
  readonly connection: Connection;
  identity: Promise<SocketIdentity | undefined>;
  cancelExpiry?: () => void;
  /** Present while a subscription is being replayed. */
  holding?: ServerFrame[] | undefined;
  /**
   * Channels whose access ended while the replay was being read. The replay was
   * authorised before that and read after it, so it may carry messages written
   * after the revocation; they are not written.
   */
  revokedWhileHolding?: Set<string> | undefined;
  /** The last queued frame's work; the next one starts when it settles. */
  tail: Promise<void>;
  queued: number;
  /** Set once the identity is resolved, so the per-user count can be given back. */
  userId?: string;
  /** Set when the hub closes the connection itself, so queued work stops at once. */
  ending: boolean;
}

export interface HubOptions {
  readonly log: Logger;
  /**
   * Stops a connection listening to a channel. The hub calls it when it delivers an
   * `ACCESS_REVOKED`, so the revocation takes effect on this node whichever node
   * published it; the bus is not a dependency of the hub, so it is handed in.
   */
  readonly leave: (channelId: string, socketId: string) => void;
  /**
   * Called once a connection's identity is first read, **before** the session is read
   * a second time to confirm it. The caller subscribes the connection to the topics
   * its end is announced on. Subscribing after the only read leaves a window in which
   * a sign-out is published to nobody and the connection stays open and authenticated
   * (a send in that window was acknowledged and stored); with the confirming read
   * after the subscription, a sign-out is either seen by the read or heard on the topic.
   */
  readonly listen: (identity: SocketIdentity) => void;
  readonly timers?: Timers;
}

/**
 * The channel a frame is about, or null for one that is about the connection. What is kept for a
 * channel the socket may not see is forgotten by this, so every kind says which it is: a frame added
 * to the contract does not compile here until it does (#412).
 */
const channelOf = (frame: ServerFrame): string | null => {
  switch (frame.event) {
    case 'MESSAGE_CREATED':
    case 'THREAD_UPDATED':
    case 'REACTIONS_UPDATED':
    case 'MESSAGE_REVISED':
    case 'CHANNEL_STATE':
    case 'CHANNEL_UPDATED':
    case 'PINS_UPDATED':
    case 'TYPING':
      return frame.data.channelId;
    // An invitation into a channel, not news from one: a later revocation follows it in order.
    case 'CHANNEL_ADDED':
    case 'ACK':
    case 'ERROR':
    case 'SESSION_ENDED':
    case 'ACCESS_REVOKED':
    case 'WORKSPACE_UPDATED':
    case 'DEEP_WORK_UPDATED':
    case 'SAVED_UPDATED':
    case 'CHANNELS_UPDATED':
    case 'PONG':
      return null;
  }
};

export const createSocketHub = (
  database: Executor,
  clock: Clock,
  { log, leave, listen, timers = systemTimers }: HubOptions,
): SocketHub => {
  const held = new Map<string, Held>();
  const running = new Set<Promise<void>>();
  const byUser = new Map<string, number>();

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

  const purge = (socket: Held, channelIds: ReadonlySet<string>): void => {
    socket.holding = socket.holding?.filter((kept) => {
      const channelId = channelOf(kept);
      return channelId === null || !channelIds.has(channelId);
    });
  };

  const deliver = (socketId: string, frame: ServerFrame): void => {
    const socket = held.get(socketId);
    // A frame for a connection that has gone is dropped, not queued. Delivery is
    // best-effort by design: what a client missed it asks for on reconnect, by
    // keyset (`ARCHITECTURE.md` §5.4).
    if (socket === undefined) return;
    if (frame.event === 'ACCESS_REVOKED') {
      // Takes effect now, even behind a replay: what was kept for these channels is
      // forgotten, and nothing published to them reaches this connection again. The
      // notice itself follows in order, so the client hears it after its replay.
      for (const channelId of frame.data.channelIds) {
        leave(channelId, socketId);
        socket.revokedWhileHolding?.add(channelId);
      }
      purge(socket, new Set(frame.data.channelIds));
    }
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
    const owner = await sessionFromCookie(database, clock, request.headers.get('cookie'));
    return owner === undefined
      ? undefined
      : { socketId, userId: owner.userId, sessionId: owner.sessionId, expiresAt: owner.expiresAt };
  };

  return {
    opened: async (socketId, connection, request): Promise<SocketIdentity | undefined> => {
      const entry: Held = {
        connection,
        identity: Promise.resolve(undefined),
        tail: Promise.resolve(),
        queued: 0,
        ending: false,
      };
      held.set(socketId, entry);

      // The promise is held, not its result, so two frames racing the resolution
      // share its reads and its one timer.
      entry.identity = (async (): Promise<SocketIdentity | undefined> => {
        const first = await resolve(socketId, request);
        // Closed, or no session: subscribe nothing for a connection that is gone.
        if (first === undefined || held.get(socketId) !== entry) return undefined;
        listen(first);
        // Read again now that the end of this session would reach it: a sign-out
        // before this read is seen here, one after it is heard on the topic.
        const confirmed = await resolve(socketId, request);
        return confirmed?.sessionId === first.sessionId ? first : undefined;
      })();

      const identity = await entry.identity;
      // Closed while its identity was being resolved: arm nothing for a
      // connection that is gone, or its timer and topic outlive it.
      if (held.get(socketId) !== entry) return undefined;
      if (identity === undefined) {
        // Admission checked the session before the socket was bound; it ended in
        // between. Nothing on this connection can be answered.
        connection.close(CLOSE_CODES.SESSION_ENDED, 'signed-out');
        return undefined;
      }
      entry.userId = identity.userId;
      byUser.set(identity.userId, (byUser.get(identity.userId) ?? 0) + 1);
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
      const socket = held.get(socketId);
      socket?.cancelExpiry?.();
      if (socket?.userId !== undefined) {
        const remaining = (byUser.get(socket.userId) ?? 1) - 1;
        // An empty count is a leak that grows with every user who ever connected.
        if (remaining <= 0) byUser.delete(socket.userId);
        else byUser.set(socket.userId, remaining);
      }
      held.delete(socketId);
    },

    closeAll: (code: number, reason: string): void => {
      for (const socket of held.values()) socket.connection.close(code, reason);
    },

    deliver,

    hold: (socketId: string): void => {
      const socket = held.get(socketId);
      if (socket === undefined) return;
      socket.holding = [];
      socket.revokedWhileHolding = new Set();
    },

    reply: (socketId: string, replies: readonly ServerFrame[]): void => {
      const socket = held.get(socketId);
      if (socket === undefined) return;
      const kept = socket.holding ?? [];
      const revoked = socket.revokedWhileHolding ?? new Set<string>();
      socket.holding = undefined;
      socket.revokedWhileHolding = undefined;
      const replayed = new Set<string>();
      for (const reply of replies) {
        // Read after the revocation, so it may carry what was written since.
        if (reply.event === 'MESSAGE_CREATED' && revoked.has(reply.data.channelId)) continue;
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

    drop: (socketId: string, channelIds: readonly string[]): void => {
      const socket = held.get(socketId);
      if (socket !== undefined) purge(socket, new Set(channelIds));
    },

    enqueue: (socketId: string, work: () => Promise<void>): void => {
      const socket = held.get(socketId);
      if (socket === undefined || socket.ending) return;
      if (socket.queued >= FRAME_QUEUE_MAX) {
        log.warn('socket sent frames faster than they could be handled and was closed', {
          socketId,
        });
        socket.ending = true;
        socket.connection.close(CLOSE_CODES.TOO_BUSY, 'busy');
        return;
      }
      socket.queued += 1;
      const run: Promise<void> = socket.tail
        .then(async () => {
          // Closed while it waited its turn: nothing it would do can be answered.
          if (held.get(socketId) !== socket || socket.ending) return;
          await work();
        })
        .catch((error: unknown) => {
          log.error('a frame handler failed', { socketId, err: error });
        })
        .finally(() => {
          socket.queued -= 1;
          running.delete(run);
        });
      socket.tail = run;
      running.add(run);
    },

    settled: async (): Promise<void> => {
      while (running.size > 0) await Promise.allSettled([...running]);
    },

    size: (): number => held.size,

    connectionsOf: (userId: string): number => byUser.get(userId) ?? 0,
  };
};
