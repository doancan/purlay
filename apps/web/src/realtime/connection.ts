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
 * An HTTP-discovered departure uses an isolated, one-shot subscription with no cursor: only the
 * server’s departure reason is forwarded, never its replay, content, or diagnostic ACK/error.
 * Ordinary frames are handed to `onFrame` untouched for exactly that reason; this
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
  CHECK_SESSION_AFTER_FAILURES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  STABLE_AFTER_MS,
  TOO_BUSY_BACKOFF_STEP,
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

interface Socket {
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
 * What asking the API about the session found. `ended` means a 401 or an account
 * that no longer owns this connection; a network error or a 5xx is `unknown` — an outage is not a sign-out, and
 * reading one as the other would sign people out whenever the server is down.
 */
export type SessionCheck = 'active' | 'ended' | 'unknown';

/** A background identity read may wait this long; a timeout says nothing about sign-in. */
export const SESSION_CHECK_DEADLINE_MS = 30_000;

interface SessionProbe {
  readonly controller: AbortController;
  readonly cancelDeadline: () => void;
}

export interface ConnectionOptions {
  readonly url: string;
  readonly openSocket: OpenSocket;
  /** A supplied owner must still authorize every physical connection and write. */
  readonly canUse?: () => boolean;
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
  readonly checkSession: (signal: AbortSignal) => Promise<SessionCheck>;
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
  /** Ask once why previously owned channels left, without receiving their content or replay. */
  readonly explainDepartures: (channelIds: readonly string[]) => void;
  /**
   * Stop receiving these channels: **one** `UNSUBSCRIBE` for all of them (chunked at the frame's
   * bound), never one per channel — a burst of per-channel frames spends the socket's frame budget,
   * and a message sent in that second is refused (#523).
   */
  readonly unwatch: (channelIds: readonly string[]) => void;
  /** Let go of channels the server already dropped (`ACCESS_REVOKED`): nothing is sent (#523). */
  readonly forget: (channelIds: readonly string[]) => void;
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
  /**
   * The browser says the network is gone (`offline`). A socket does not close when the network
   * goes, so without this it would read `open` until a `PING` went unanswered — up to
   * `PING_AFTER_IDLE_MS` + `PONG_DEADLINE_MS` of a page that looks connected and is not (#626).
   * An open or opening socket is declared dead at once; anything else is left as it is.
   */
  readonly networkLost: () => void;
  /**
   * The browser says the network is back (`online`): the backoff starts over, so the next attempt
   * comes within a jittered second — an attempt hanging on the dead network is given up for it — and
   * an open socket is asked at once whether it lived through the gap. Never starts a connection that
   * was not running.
   */
  readonly networkBack: () => void;
}

export const createConnection = (options: ConnectionOptions): Connection => {
  const cursors = createCursors();
  const watched = new Set<string>();
  // Object identity separates a new loss from a prior probe of the same channel.
  const explanations = new Map<string, object>();
  const conclusions = new Map<
    string,
    { readonly owners: ReadonlyMap<string, object>; readonly barrier: string }
  >();
  // Ignore live content until the successful probe's UNSUBSCRIBE is acknowledged.
  const retiring = new Set<string>();
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
  // Only the active diagnostic can end this connection. Release its slot before abort:
  // even an ignored abort or a reentrant transport listener cannot retain/clear its replacement.
  let checking: SessionProbe | null = null;
  const releaseCheck = (abort: boolean): void => {
    const check = checking;
    if (check === null) return;
    checking = null;
    check.cancelDeadline();
    if (abort) check.controller.abort();
  };

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

  const stop = (): void => {
    generation += 1;
    releaseCheck(true);
    pingSent = null;
    clearTimers();
    socket?.close();
    socket = null;
    explanations.clear();
    conclusions.clear();
    retiring.clear();
    setStatus('idle');
  };

  const usable = (): boolean => {
    if (options.canUse?.() !== false) return true;
    stop();
    return false;
  };

  const write = (frame: ClientFrame): boolean => {
    if (!usable()) return false;
    if (status !== 'open' || socket === null) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch {
      dead();
      return false;
    }
  };

  // Channels waiting for a SUBSCRIBE, the one chunk on the wire, and the pause
  // before it is sent again after the server said RATE_LIMITED.
  let queue: string[] = [];
  let inFlight: {
    readonly id: string;
    readonly channelIds: readonly string[];
    readonly diagnostic: ReadonlyMap<string, object> | null;
  } | null = null;
  let limitedTimes = 0;
  let cancelResend: (() => void) | null = null;

  /** Stops watching these, and returns the ones that were watched, each once. */
  const letGo = (channelIds: readonly string[]): string[] => {
    const gone: string[] = [];
    for (const channelId of channelIds) {
      explanations.delete(channelId);
      retiring.delete(channelId);
      if (!watched.delete(channelId)) continue;
      pending.delete(channelId);
      gone.push(channelId);
    }
    return gone;
  };

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
    let diagnostic: boolean | null = null;
    while (chunk.length < SUBSCRIBE_MAX_CHANNELS) {
      const next = queue[0];
      if (next === undefined) break;
      if (!watched.has(next) && !explanations.has(next)) {
        queue.shift();
        continue;
      }
      // A refused explanation must never refuse a current member's subscription with it.
      if (diagnostic !== null && diagnostic !== explanations.has(next)) break;
      diagnostic = explanations.has(next);
      queue.shift();
      chunk.push(next);
    }
    if (chunk.length > 0) sendChunk(chunk, diagnostic === true);
  };

  const sendChunk = (channelIds: readonly string[], diagnostic: boolean): void => {
    const live = channelIds.filter((channelId) =>
      diagnostic ? explanations.has(channelId) : watched.has(channelId),
    );
    if (live.length === 0) {
      inFlight = null;
      pump();
      return;
    }
    const id = options.newId();
    const owners = diagnostic ? new Map<string, object>() : null;
    if (owners !== null) {
      for (const channelId of live) {
        const owner = explanations.get(channelId);
        if (owner !== undefined) owners.set(channelId, owner);
      }
    }
    inFlight = { id, channelIds: live, diagnostic: owners };
    write({
      id,
      op: 'SUBSCRIBE',
      payload: {
        channels: live.map((channelId) => ({
          channelId,
          afterMessageId: diagnostic ? null : cursors.get(channelId),
        })),
      },
    });
  };

  const unsubscribe = (channelIds: readonly string[]): void => {
    for (let at = 0; at < channelIds.length; at += SUBSCRIBE_MAX_CHANNELS) {
      write({
        id: options.newId(),
        op: 'UNSUBSCRIBE',
        payload: { channelIds: channelIds.slice(at, at + SUBSCRIBE_MAX_CHANNELS) },
      });
    }
  };

  /** The answer to the chunk on the wire: go on, or send it again after a wait. */
  const answered = (frame: ServerFrame): void => {
    if (inFlight === null || frame.refId !== inFlight.id) return;
    if (frame.event === 'ACK' && 'channels' in frame.data) {
      const { channelIds, diagnostic } = inFlight;
      inFlight = null;
      if (diagnostic !== null) {
        for (const [id, owner] of diagnostic) {
          if (explanations.get(id) === owner) explanations.delete(id);
        }
        const released = channelIds.filter((id) => !watched.has(id));
        for (const id of released) retiring.add(id);
        unsubscribe(released);
      }
      limitedTimes = 0;
      pump();
    } else if (frame.event === 'ERROR') {
      if (frame.data.code === 'RATE_LIMITED' || frame.data.code === 'DATABASE_UNAVAILABLE') {
        const { channelIds: again, diagnostic } = inFlight;
        cancelResend = options.schedule(
          () => {
            cancelResend = null;
            sendChunk(again, diagnostic !== null);
          },
          reconnectDelay(limitedTimes, options.random),
        );
        limitedTimes += 1;
      } else {
        // Refused for a reason waiting will not change: say so, and go on with the next chunk.
        const { channelIds, id, diagnostic } = inFlight;
        inFlight = null;
        if (diagnostic !== null) {
          if (frame.data.code === 'CHANNEL_NOT_FOUND') {
            // ERROR is followed by a separate reason. A later PONG proves the server's FIFO reply
            // finished; a disconnect before it retains this intent for the next socket.
            const barrier = options.newId();
            conclusions.set(id, { owners: diagnostic, barrier });
            write({ id: barrier, op: 'PING', payload: {} });
          } else {
            for (const [channelId, owner] of diagnostic) {
              if (explanations.get(channelId) === owner) explanations.delete(channelId);
            }
          }
        } else options.onSubscribeRefused?.(channelIds, frame.data.code, id);
        pump();
      }
    }
  };

  const end = (): void => {
    generation += 1;
    socket?.close();
    socket = null;
    pingSent = null;
    clearTimers();
    // Whatever ended it, the next life starts clean: a restart after sign-in must
    // not inherit a backoff earned by the last session.
    failures = 0;
    neverOpened = 0;
    releaseCheck(true);
    explanations.clear();
    conclusions.clear();
    retiring.clear();
    setStatus('ended');
  };

  const askAboutSession = (): void => {
    if (checking !== null) return;
    const check: SessionProbe = {
      controller: new AbortController(),
      cancelDeadline: options.schedule(() => {
        if (checking === check) releaseCheck(true);
      }, SESSION_CHECK_DEADLINE_MS),
    };
    checking = check;
    const answer = async (): Promise<SessionCheck> => {
      try {
        return await options.checkSession(check.controller.signal);
      } catch {
        // The question failing says nothing about the session: an outage.
        return 'unknown';
      }
    };
    void answer().then((answer) => {
      if (checking !== check) return;
      releaseCheck(false);
      if (answer === 'ended') end();
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
    if (!usable()) return;
    generation += 1;
    const mine = generation;
    setStatus('connecting');

    const handlers: SocketHandlers = {
      opened: (): void => {
        if (mine !== generation) return;
        setStatus('open');
        neverOpened = 0;
        releaseCheck(true);
        // Whatever the last connection owed is superseded by this one's replay.
        pending.clear();
        cancelStable = options.schedule(() => {
          failures = 0;
        }, STABLE_AFTER_MS);
        retiring.clear();
        conclusions.clear();
        queue = [...watched, ...explanations.keys()];
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
        let { frame } = message;
        measureClock(frame);
        if (frame.event === 'PONG' || frame.event === 'ERROR') {
          let completed = false;
          for (const [requestId, conclusion] of conclusions) {
            if (conclusion.barrier !== frame.refId) continue;
            for (const [id, owner] of conclusion.owners) {
              if (explanations.get(id) === owner) explanations.delete(id);
            }
            conclusions.delete(requestId);
            completed = true;
          }
          // Even a rate refusal proves this later request passed the server's FIFO boundary.
          if (completed) return;
        }
        if (frame.event === 'ACCESS_REVOKED' && frame.refId !== undefined) {
          const conclusion = conclusions.get(frame.refId);
          if (conclusion !== undefined) {
            const ids = frame.data.channelIds.filter((id) => {
              const owner = conclusion.owners.get(id);
              return owner !== undefined && explanations.get(id) === owner;
            });
            if (ids.length === 0) return;
            for (const id of ids) explanations.delete(id);
            frame = { ...frame, data: { ...frame.data, channelIds: ids } };
          }
        }
        const diagnostic =
          inFlight !== null &&
          inFlight.diagnostic !== null &&
          frame.refId === inFlight.id &&
          (frame.event === 'ERROR' || (frame.event === 'ACK' && 'channels' in frame.data));
        if (!diagnostic) noteReplay(frame);
        answered(frame);
        if (diagnostic) return;
        if (
          'channelId' in frame.data &&
          (explanations.has(frame.data.channelId) || retiring.has(frame.data.channelId))
        )
          return;
        if (frame.event === 'ACK' && 'channelIds' in frame.data) {
          for (const id of frame.data.channelIds) retiring.delete(id);
        }
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
    stop,
    status: (): ConnectionStatus => status,
    watch: (channelId): void => {
      if (watched.has(channelId)) return;
      explanations.delete(channelId);
      retiring.delete(channelId);
      watched.add(channelId);
      if (!queue.includes(channelId)) queue.push(channelId);
      pump();
    },
    explainDepartures: (channelIds): void => {
      for (const id of channelIds) {
        if (watched.has(id) || explanations.has(id) || retiring.has(id)) continue;
        explanations.set(id, {});
        if (!queue.includes(id)) queue.push(id);
      }
      pump();
    },
    unwatch: (channelIds): void => {
      unsubscribe(letGo(channelIds));
    },
    forget: (channelIds): void => {
      letGo(channelIds);
    },
    observe: cursors.observe,
    pendingContinuations: (): ReadonlyMap<string, string> => new Map(pending),
    continuationDone: (channelId, from): void => {
      if (pending.get(channelId) === from.toLowerCase()) pending.delete(channelId);
    },
    send: write,
    networkLost: (): void => {
      if (status === 'open' || status === 'connecting') dead();
    },
    networkBack: (): void => {
      if (status === 'open') {
        if (pingSent === null) ping();
        return;
      }
      if (status !== 'waiting' && status !== 'connecting') return;
      // An attempt begun on the dead network may hang until the system gives up on it: let it go.
      if (status === 'connecting') {
        generation += 1;
        socket?.close();
        socket = null;
      }
      // What was earned while offline says nothing about the network now back: the ladder starts
      // over, at its first rung's jittered wait rather than at once, so the pages on a network that
      // came back together do not all arrive in the same instant (D-76). `neverOpened` is kept: a
      // session that ended is still found after the attempts that never open.
      cancelRetry?.();
      setStatus('waiting');
      cancelRetry = options.schedule(connect, reconnectDelay(0, options.random));
      // The first rung is this wait; an attempt after it that fails climbs from there.
      failures = 1;
    },
  };
};
