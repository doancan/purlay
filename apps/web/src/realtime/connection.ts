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
 * module reads them only to advance a cursor — and to withhold that advance
 * while a continuation is owed (`pendingContinuations`, D-82).
 *
 * **Whether the socket is alive** is its business too: a `PING` while open, and
 * silence past a deadline is a dead socket (D-82). The first `PONG` measures the
 * server's clock (D-33).
 *
 * **Everything outside the process is an argument** — the socket, the timers,
 * the dice, the clock, the id generator — so a test drives a dropped connection
 * by hand instead of waiting thirty seconds for one (D-46).
 */
import {
  CLOSE_CODES,
  SUBSCRIBE_MAX_CHANNELS,
  parseServerMessage,
  type ClientFrame,
  type ErrorCode,
  type ServerFrame,
} from '@purlay/types';
import { reconnectDelay } from './backoff';
import type { Clock } from './clock';
import { createCursors } from './cursors';
import type { ServerClock } from './server-clock';

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
 * only be refused (`start` leaves it).
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

/**
 * How long a connection may say nothing before it is asked whether it is there.
 *
 * Under the 60 s idle timeout that proxies and load balancers commonly apply to
 * a connection carrying nothing, so a quiet channel does not get the socket
 * closed from outside; and a busy connection is never pinged at all, because
 * every inbound frame counts as proof of life and restarts this wait. (D-82)
 */
export const PING_AFTER_IDLE_MS = 25_000;

/**
 * How long a `PING` may go unanswered — by anything — before the socket is
 * declared dead.
 *
 * A half-open socket (a sleeping laptop, a dead NAT mapping, a mobile handoff)
 * reads `open` until the operating system's TCP timeout, which is minutes. Fifteen
 * seconds outlasts a retransmission or two on a poor mobile link, and keeps the
 * worst case — silence, then this — at 40 s. (D-82)
 */
export const PONG_DEADLINE_MS = 15_000;

/**
 * How many handshakes in a row may fail before reaching `open` before the
 * session is asked about.
 *
 * The browser hides why a handshake failed — a refusal (401) and an outage both
 * surface as close code 1006 — so the only way to tell them apart is to ask the
 * API. Three failures is past a single dropped connection or a server restart,
 * and early enough that a signed-out user retries for seconds, not forever. (D-82)
 */
export const CHECK_SESSION_AFTER_FAILURES = 3;

/**
 * What asking the API about the session found. `ended` is a 401 and nothing
 * else; a network error or a 5xx is `unknown` — an outage is not a sign-out, and
 * reading one as the other would sign people out whenever the server is down.
 */
export type SessionCheck = 'active' | 'ended' | 'unknown';

/**
 * Where on the backoff ladder a `TOO_BUSY` close starts the wait.
 *
 * The server closes with 1013 — *try again later* — when it was handed more than
 * it could take in turn. Coming back after the first rung (half a second to a
 * second) is coming back into the same pile; the fourth (4–8 s) lets the queue
 * that caused it drain. It only ever raises the failures already counted, so a
 * long outage keeps its longer wait. Pacing (`subscribe`) is what keeps a healthy
 * client from earning this at all. (D-82)
 */
export const TOO_BUSY_BACKOFF_STEP = 3;

export interface ConnectionOptions {
  readonly url: string;
  readonly openSocket: OpenSocket;
  readonly schedule: Schedule;
  readonly random: () => number;
  /** The local clock: when a `PING` left and when its `PONG` arrived. */
  readonly clock: Clock;
  /** Told of the first `PONG`; ids are generated against it. */
  readonly serverClock: Pick<ServerClock, 'observe' | 'corrected'>;
  /**
   * Asks the API whether the session still exists (`GET /api/me`). Injected so
   * this module never names `fetch`. A rejection is read as `unknown`.
   */
  readonly checkSession: () => Promise<SessionCheck>;
  /** A fresh UUIDv7 for a frame's correlation id; the caller owns the clock it is made on. */
  readonly newId: () => string;
  readonly onFrame: (frame: ServerFrame) => void;
  readonly onStatus?: (status: ConnectionStatus) => void;
  /**
   * A chunk of channels the server refused for a reason waiting will not change, with its
   * code and the id of the `SUBSCRIBE` it answers. Told **before** `onFrame` gets the same
   * `ERROR`, so whoever owns the store can say so and then recognise the frame. Without it a
   * refusal is skipped silently here and those channels never receive another message.
   */
  readonly onSubscribeRefused?: (
    channelIds: readonly string[],
    code: ErrorCode,
    refId: string,
  ) => void;
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
  /**
   * Channels whose replay was one page, and the `nextCursor` it stopped at. The
   * store owes each an HTTP continuation from that id; until `continuationDone`,
   * live frames do not move that channel's cursor (D-82).
   */
  readonly pendingContinuations: () => ReadonlyMap<string, string>;
  /**
   * The continuation that began at `from` reached the present. Ignored if the
   * channel's pending replay is not the one that began there: a continuation
   * belonging to an earlier connection must not release a newer one.
   */
  readonly continuationDone: (channelId: string, from: string) => void;
  /** `false` when the frame did not leave, so the caller keeps it to send again. */
  readonly send: (frame: ClientFrame) => boolean;
}

export const createConnection = (options: ConnectionOptions): Connection => {
  const cursors = createCursors();
  const watched = new Set<string>();
  // Channel -> the `nextCursor` of a replay whose HTTP continuation is still owed.
  const pending = new Map<string, string>();

  let status: ConnectionStatus = 'idle';
  let socket: Socket | null = null;
  // Identifies the socket in use. A handler from an earlier one is ignored, so a
  // late `closed` after `stop` cannot schedule a reconnect nobody asked for.
  let generation = 0;
  let failures = 0;
  // Handshakes in a row that never reached `open`. `failures` is forgiven only
  // by a connection that held; this by one that merely opened.
  let neverOpened = 0;
  let cancelRetry: (() => void) | null = null;
  let cancelStable: (() => void) | null = null;
  let cancelBeat: (() => void) | null = null;
  // The PING whose answer is still wanted for the clock, and when it left.
  let pingSent: { readonly id: string; readonly at: Date } | null = null;
  // A session check is in flight, and which life of the connection asked. The
  // epoch moves on anything that makes an answer stale: `stop`, an `open`, an end.
  let checking = false;
  let checkEpoch = 0;

  const setStatus = (next: ConnectionStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus?.(next);
  };

  const clearTimers = (): void => {
    cancelRetry?.();
    cancelStable?.();
    cancelBeat?.();
    cancelResend?.();
    cancelRetry = null;
    cancelStable = null;
    cancelBeat = null;
    cancelResend = null;
    inFlight = null;
  };

  const write = (frame: ClientFrame): boolean => {
    if (status !== 'open' || socket === null) return false;
    socket.send(JSON.stringify(frame));
    return true;
  };

  // Channels waiting for a SUBSCRIBE, the one chunk on the wire, and the pause
  // before it is sent again after the server said RATE_LIMITED.
  let queue: string[] = [];
  let inFlight: { readonly id: string; readonly channelIds: readonly string[] } | null = null;
  let limitedTimes = 0;
  let cancelResend: (() => void) | null = null;

  /**
   * Send the next chunk, if none is on the wire. **One at a time**, the next
   * after the last is answered: a hundred channels per frame, thirty-five frames
   * for 3,500 channels, sent together, exceed the server's frame budget (answered
   * `RATE_LIMITED`, which nothing retried) and then its queue bound (the close
   * `TOO_BUSY`, on every attempt). The numbers are the server's to own
   * (`SOCKET_FRAME_BUDGET`, `FRAME_QUEUE_MAX`); waiting for the answer needs none
   * of them. Cursors are read when a chunk leaves, not when it was queued. (D-82)
   */
  const pump = (): void => {
    if (inFlight !== null || status !== 'open') return;
    const chunk: string[] = [];
    while (chunk.length < SUBSCRIBE_MAX_CHANNELS) {
      const next = queue.shift();
      if (next === undefined) break;
      chunk.push(next);
    }
    if (chunk.length > 0) sendChunk(chunk);
  };

  const sendChunk = (channelIds: readonly string[]): void => {
    const live = channelIds.filter((channelId) => watched.has(channelId));
    if (live.length === 0) {
      inFlight = null;
      pump();
      return;
    }
    const id = options.newId();
    inFlight = { id, channelIds: live };
    write({
      id,
      op: 'SUBSCRIBE',
      payload: {
        channels: live.map((channelId) => ({ channelId, afterMessageId: cursors.get(channelId) })),
      },
    });
  };

  /** The answer to the chunk on the wire: go on, or send it again after a wait. */
  const answered = (frame: ServerFrame): void => {
    if (inFlight === null || frame.refId !== inFlight.id) return;
    if (frame.event === 'ACK' && 'channels' in frame.data) {
      inFlight = null;
      limitedTimes = 0;
      pump();
    } else if (frame.event === 'ERROR') {
      if (frame.data.code === 'RATE_LIMITED' || frame.data.code === 'DATABASE_UNAVAILABLE') {
        const again = inFlight.channelIds;
        cancelResend = options.schedule(
          () => {
            cancelResend = null;
            sendChunk(again);
          },
          reconnectDelay(limitedTimes, options.random),
        );
        limitedTimes += 1;
      } else {
        // Refused for a reason waiting will not change: say so, and go on with the next chunk.
        const { channelIds, id } = inFlight;
        inFlight = null;
        options.onSubscribeRefused?.(channelIds, frame.data.code, id);
        pump();
      }
    }
  };

  const end = (): void => {
    socket = null;
    pingSent = null;
    clearTimers();
    // Whatever ended it, the next life starts clean: a restart after sign-in must
    // not inherit a backoff earned by the last session.
    failures = 0;
    neverOpened = 0;
    checkEpoch += 1;
    setStatus('ended');
  };

  const askAboutSession = (): void => {
    if (checking) return;
    checking = true;
    const epoch = checkEpoch;
    const answer = async (): Promise<SessionCheck> => {
      try {
        return await options.checkSession();
      } catch {
        // The question failing says nothing about the session: an outage.
        return 'unknown';
      }
    };
    void answer().then((check) => {
      checking = false;
      if (epoch === checkEpoch && check === 'ended') end();
    });
  };

  const lost = (): void => {
    socket = null;
    pingSent = null;
    cancelStable?.();
    cancelBeat?.();
    cancelResend?.();
    cancelStable = null;
    cancelBeat = null;
    cancelResend = null;
    inFlight = null;
    setStatus('waiting');
    cancelRetry = options.schedule(connect, reconnectDelay(failures, options.random));
    failures += 1;
    neverOpened += 1;
    if (neverOpened >= CHECK_SESSION_AFTER_FAILURES) askAboutSession();
  };

  /** Declare the socket dead and move on without waiting for it to say so. */
  const dead = (): void => {
    // A half-open socket's own `close` event may be minutes away. The generation
    // makes it, when it comes, change nothing.
    generation += 1;
    socket?.close();
    lost();
  };

  const armIdle = (): void => {
    cancelBeat?.();
    cancelBeat = options.schedule(ping, PING_AFTER_IDLE_MS);
  };

  function ping(): void {
    const id = options.newId();
    if (!write({ id, op: 'PING', payload: {} })) return;
    pingSent = { id, at: options.clock.now() };
    cancelBeat?.();
    cancelBeat = options.schedule(dead, PONG_DEADLINE_MS);
  }

  const measureClock = (frame: ServerFrame): void => {
    if (frame.event !== 'PONG' || pingSent === null || frame.refId !== pingSent.id) return;
    const sample = { sentAt: pingSent.at, receivedAt: options.clock.now(), serverTs: frame.ts };
    pingSent = null;
    // A local clock that stepped backwards mid-round-trip gives a sample the
    // server clock refuses; skip it and measure again on the next PING.
    if (sample.receivedAt.getTime() < sample.sentAt.getTime()) return;
    if (!options.serverClock.corrected()) options.serverClock.observe(sample);
  };

  /** A live frame moves the cursor — unless a continuation is owed for its channel. */
  const advance = (channelId: string, id: string): void => {
    const owed = pending.get(channelId);
    if (owed !== undefined && id.toLowerCase() > owed) return;
    cursors.observe(channelId, id);
  };

  const noteReplay = (frame: ServerFrame): void => {
    if (frame.event !== 'ACK' || !('channels' in frame.data)) return;
    for (const { channelId, nextCursor } of frame.data.channels) {
      if (nextCursor === null) pending.delete(channelId);
      else pending.set(channelId, nextCursor.toLowerCase());
    }
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
        neverOpened = 0;
        checkEpoch += 1;
        // Whatever the last connection owed is superseded by this one's replay.
        pending.clear();
        cancelStable = options.schedule(() => {
          failures = 0;
        }, STABLE_AFTER_MS);
        queue = [...watched];
        limitedTimes = 0;
        pump();
        ping();
      },
      message: (data): void => {
        if (mine !== generation) return;
        const message = typeof data === 'string' ? parseServerMessage(data) : null;
        if (message === null || message.kind === 'malformed') {
          // Not a frame this contract could have sent. Guessing at it would fold
          // an unknown into the message list; ending the connection replays from
          // the cursor and loses nothing. (CONTRIBUTING §6.4)
          socket?.close();
          return;
        }
        // Anything well-formed proves the peer is there, an event we do not know
        // included: a newer server is not a reason to leave it (D-82).
        armIdle();
        if (message.kind === 'unknown') return;
        const { frame } = message;
        measureClock(frame);
        noteReplay(frame);
        answered(frame);
        if (frame.event === 'MESSAGE_CREATED') advance(frame.data.channelId, frame.data.id);
        options.onFrame(frame);
      },
      closed: (code): void => {
        if (mine !== generation) return;
        if (code === CLOSE_CODES.SESSION_ENDED) {
          end();
          return;
        }
        // Told to come back later: begin the wait part-way up the ladder.
        if (code === CLOSE_CODES.TOO_BUSY) failures = Math.max(failures, TOO_BUSY_BACKOFF_STEP);
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
      // From `ended` too: signing in again is how a session comes back, and the
      // channels watched and the cursors held are still the right ones to resume. (D-82)
      if (status === 'idle' || status === 'ended') connect();
    },
    stop: (): void => {
      generation += 1;
      checkEpoch += 1;
      pingSent = null;
      clearTimers();
      socket?.close();
      socket = null;
      setStatus('idle');
    },
    status: (): ConnectionStatus => status,
    watch: (channelId): void => {
      if (watched.has(channelId)) return;
      watched.add(channelId);
      queue.push(channelId);
      pump();
    },
    unwatch: (channelId): void => {
      if (!watched.delete(channelId)) return;
      pending.delete(channelId);
      write({ id: options.newId(), op: 'UNSUBSCRIBE', payload: { channelIds: [channelId] } });
    },
    observe: cursors.observe,
    pendingContinuations: (): ReadonlyMap<string, string> => new Map(pending),
    continuationDone: (channelId, from): void => {
      if (pending.get(channelId) === from.toLowerCase()) pending.delete(channelId);
    },
    send: write,
  };
};
