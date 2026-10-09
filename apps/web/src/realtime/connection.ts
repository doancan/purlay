/**
 * The socket client: connect, and when it drops, come back and catch up
 * (`ARCHITECTURE.md` §5.4).
 *
 * **What it owns.** The socket's life, the set of channels being watched, and
 * the highest message id heard in each. On every (re)connect it sends `SUBSCRIBE`
 * with those ids, and the server answers with what may have been missed.
 *
 * **What it does not.** Optimistic sends and their ACK deadline, the message
 * buffer, and continuing a replay that was only one page (`nextCursor` in the
 * `ACK`, then `?after=` over HTTP) belong to the store that sits on top of this.
 * Every frame is handed to `onFrame` untouched for exactly that reason; this
 * module reads them only to advance a cursor.
 *
 * **Everything outside the process is an argument** — the socket, the timers,
 * the dice, the id generator — so a test drives a dropped connection by hand
 * instead of waiting thirty seconds for one (D-46).
 */
import {
  CLOSE_CODES,
  SUBSCRIBE_MAX_CHANNELS,
  parseServerFrame,
  type ClientFrame,
  type ServerFrame,
} from '@purlay/types';
import { reconnectDelay } from './backoff';
import { createCursors } from './cursors';

/** What a socket tells whoever opened it. */
export interface SocketHandlers {
  readonly opened: () => void;
  /** Text or binary: the transport does not promise which, and the contract is text. */
  readonly message: (data: unknown) => void;
  readonly closed: (code: number) => void;
}

export interface Socket {
  readonly send: (text: string) => void;
  readonly close: () => void;
}

export type OpenSocket = (url: string, handlers: SocketHandlers) => Socket;

/** Runs `fn` after `ms`; the returned function cancels it. */
export type Schedule = (fn: () => void, ms: number) => () => void;

/**
 * `idle` before `start` and after `stop` · `connecting` · `open` · `waiting` for
 * the next attempt · `ended` when the session is over and reconnecting would
 * only be refused.
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'waiting' | 'ended';

/**
 * How long a connection must hold before the backoff forgives it.
 *
 * Without this a server that accepts and then drops every connection is
 * "successfully connected" each time, and is retried at the shortest delay
 * forever. Long enough to outlast a handshake and a first replay; short enough
 * that a healthy reconnect is not penalised for the outage before it. (D-76)
 */
export const STABLE_AFTER_MS = 10_000;

export interface ConnectionOptions {
  readonly url: string;
  readonly openSocket: OpenSocket;
  readonly schedule: Schedule;
  readonly random: () => number;
  /** A fresh UUIDv7 for a frame's correlation id; the caller owns the clock it is made on. */
  readonly newId: () => string;
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
}

export interface Connection {
  readonly start: () => void;
  readonly stop: () => void;
  readonly status: () => ConnectionStatus;
  /** Receive a channel's messages, resuming from the highest id held. */
  readonly watch: (channelId: string) => void;
  readonly unwatch: (channelId: string) => void;
  /** Note an id obtained another way — a history page — so a reconnect resumes above it. */
  readonly observe: (channelId: string, messageId: string) => void;
  /** `false` when the frame did not leave, so the caller keeps it to send again. */
  readonly send: (frame: ClientFrame) => boolean;
}

export const createConnection = (options: ConnectionOptions): Connection => {
  const cursors = createCursors();
  const watched = new Set<string>();

  let status: ConnectionStatus = 'idle';
  let socket: Socket | null = null;
  // Identifies the socket in use. A handler from an earlier one is ignored, so a
  // late `closed` after `stop` cannot schedule a reconnect nobody asked for.
  let generation = 0;
  let failures = 0;
  let cancelRetry: (() => void) | null = null;
  let cancelStable: (() => void) | null = null;

  const setStatus = (next: ConnectionStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearTimers = (): void => {
    cancelRetry?.();
    cancelStable?.();
    cancelRetry = null;
    cancelStable = null;
  };

  const write = (frame: ClientFrame): boolean => {
    if (status !== 'open' || socket === null) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };

  const subscribe = (channelIds: readonly string[]): void => {
    for (let from = 0; from < channelIds.length; from += SUBSCRIBE_MAX_CHANNELS) {
      write({
        id: options.newId(),
        op: 'SUBSCRIBE',
        payload: {
          channels: channelIds.slice(from, from + SUBSCRIBE_MAX_CHANNELS).map((channelId) => ({
            channelId,
            afterMessageId: cursors.get(channelId),
          })),
        },
      });
    }
  };

  const lost = (): void => {
    socket = null;
    cancelStable?.();
    cancelStable = null;
    setStatus('waiting');
    cancelRetry = options.schedule(connect, reconnectDelay(failures, options.random));
    failures += 1;
  };

  function connect(): void {
    cancelRetry = null;
    generation += 1;
    const mine = generation;
    setStatus('connecting');

    const handlers: SocketHandlers = {
      opened: (): void => {
        if (mine !== generation) return;
        setStatus('open');
        cancelStable = options.schedule(() => {
          failures = 0;
        }, STABLE_AFTER_MS);
        subscribe([...watched]);
      },
      message: (data): void => {
        if (mine !== generation) return;
        const frame = typeof data === 'string' ? parseServerFrame(data) : null;
        if (frame === null) {
          // Not a frame this contract defines. Guessing at it would fold an
          // unknown into the message list; ending the connection replays from the
          // cursor and loses nothing. (CONTRIBUTING §6.4)
          socket?.close();
          return;
        }
        if (frame.event === 'MESSAGE_CREATED') cursors.observe(frame.data.channelId, frame.data.id);
        options.onFrame(frame);
      },
      closed: (code): void => {
        if (mine !== generation) return;
        if (code === CLOSE_CODES.SESSION_ENDED) {
          socket = null;
          clearTimers();
          setStatus('ended');
          return;
        }
        lost();
      },
    };

    try {
      socket = options.openSocket(options.url, handlers);
    } catch {
      // A socket that cannot be created is a failed attempt like any other.
      lost();
    }
  }

  return {
    start: (): void => {
      if (status === 'idle') connect();
    },
    stop: (): void => {
      generation += 1;
      clearTimers();
      socket?.close();
      socket = null;
      setStatus('idle');
    },
    status: (): ConnectionStatus => status,
    watch: (channelId): void => {
      if (watched.has(channelId)) return;
      watched.add(channelId);
      subscribe([channelId]);
    },
    unwatch: (channelId): void => {
      if (!watched.delete(channelId)) return;
      write({ id: options.newId(), op: 'UNSUBSCRIBE', payload: { channelIds: [channelId] } });
    },
    observe: cursors.observe,
    send: write,
  };
};
