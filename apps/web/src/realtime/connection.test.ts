/**
 * Reconnect and replay (`ARCHITECTURE.md` §5.4), against a socket and timers a
 * test drives by hand — no network, no waiting.
 */
import { describe, expect, test } from 'bun:test';
import {
  CLOSE_CODES,
  SUBSCRIBE_MAX_CHANNELS,
  messageId,
  type ClientFrame,
  type ServerFrame,
} from '@purlay/types';
import { BACKOFF, reconnectDelay } from './backoff';
import type { Clock } from './clock';
import {
  CHECK_SESSION_AFTER_FAILURES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  STABLE_AFTER_MS,
  TOO_BUSY_BACKOFF_STEP,
  createConnection,
  type Connection,
  type OpenSocket,
  type SessionCheck,
  type SocketHandlers,
} from './connection';
import { createServerClock, type ServerClock } from './server-clock';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const idAt = (offsetMs: number): string => messageId(new Date(T0 + offsetMs));
const channel = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type SubscribeFrame = Extract<ClientFrame, { op: 'SUBSCRIBE' }>;

const isSubscribe = (frame: unknown): frame is SubscribeFrame =>
  typeof frame === 'object' && frame !== null && 'op' in frame && frame.op === 'SUBSCRIBE';

const isPing = (frame: unknown): frame is { id: string; op: 'PING' } =>
  typeof frame === 'object' && frame !== null && 'op' in frame && frame.op === 'PING';

interface FakeSocket {
  readonly handlers: SocketHandlers;
  readonly sent: string[];
  closedByClient: boolean;
}

interface Harness {
  readonly connection: Connection;
  readonly sockets: FakeSocket[];
  readonly timers: { fn: () => void; ms: number; live: boolean }[];
  readonly frames: ServerFrame[];
  readonly statuses: string[];
  readonly live: () => { fn: () => void; ms: number; live: boolean }[];
  readonly subscribes: (socket: FakeSocket) => SubscribeFrame[];
  readonly last: () => FakeSocket;
  /** Fire the one timer that is waiting, and say how long it waited. */
  readonly fireNext: () => number;
  /** Fire the live timer that waits `ms`. */
  readonly fireWaiting: (ms: number) => void;
  /** The local clock; `advance` moves it. */
  readonly local: Clock & { advance: (ms: number) => void };
  readonly serverClock: ServerClock;
  /** One entry per `checkSession` call, in order; settle it to answer. */
  readonly checks: { resolve: (check: SessionCheck) => void; reject: () => void }[];
  readonly pings: (socket: FakeSocket) => { id: string; op: 'PING' }[];
}

const harness = (random = (): number => 0): Harness => {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const frames: ServerFrame[] = [];
  const statuses: string[] = [];
  let counter = 0;
  let localNow = T0;
  const local = {
    now: (): Date => new Date(localNow),
    advance: (ms: number): void => {
      localNow += ms;
    },
  };
  const serverClock = createServerClock(local);
  const checks: Harness['checks'] = [];

  const openSocket: OpenSocket = (_url, handlers) => {
    const socket: FakeSocket = { handlers, sent: [], closedByClient: false };
    sockets.push(socket);
    return {
      send: (text): void => {
        socket.sent.push(text);
      },
      close: (): void => {
        socket.closedByClient = true;
      },
    };
  };

  const connection = createConnection({
    url: 'ws://test/ws',
    openSocket,
    schedule: (fn, ms) => {
      const timer = { fn, ms, live: true };
      timers.push(timer);
      return (): void => {
        timer.live = false;
      };
    },
    random,
    clock: local,
    serverClock,
    checkSession: () =>
      new Promise<SessionCheck>((resolve, reject) => {
        checks.push({
          resolve,
          reject: (): void => {
            reject(new Error('offline'));
          },
        });
      }),
    newId: () => idAt(counter++),
    onFrame: (frame) => {
      frames.push(frame);
    },
    onStatus: (status) => {
      statuses.push(status);
    },
  });

  const live = (): typeof timers => timers.filter((timer) => timer.live);
  const subscribes = (socket: FakeSocket): SubscribeFrame[] =>
    socket.sent.flatMap((text) => {
      const frame: unknown = JSON.parse(text);
      return isSubscribe(frame) ? [frame] : [];
    });
  const last = (): FakeSocket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  };
  /** Fire the one timer that is waiting, and say how long it waited. */
  const fireNext = (): number => {
    const timer = live()[0];
    if (timer === undefined) throw new Error('nothing is scheduled');
    timer.live = false;
    timer.fn();
    return timer.ms;
  };

  const fireWaiting = (ms: number): void => {
    const timer = live().find((candidate) => candidate.ms === ms);
    if (timer === undefined) throw new Error(`no timer is waiting ${String(ms)} ms`);
    timer.live = false;
    timer.fn();
  };
  const pings = (socket: FakeSocket): { id: string; op: 'PING' }[] =>
    socket.sent.flatMap((text) => {
      const frame: unknown = JSON.parse(text);
      return isPing(frame) ? [frame] : [];
    });

  return {
    connection,
    sockets,
    timers,
    frames,
    statuses,
    live,
    subscribes,
    last,
    fireNext,
    fireWaiting,
    local,
    serverClock,
    checks,
    pings,
  };
};

const created = (channelId: string, id: string): string => {
  const frame: ServerFrame = {
    event: 'MESSAGE_CREATED',
    ts: T0,
    data: {
      id,
      channelId,
      sender: { id: channel(99), username: 'a', displayName: 'A', avatarUrl: null },
      githubEvent: null,
      content: 'hi',
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(T0).toISOString(),
      parentId: null,
      thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
      reactions: [],
      mentions: [],
      attachments: [],
    },
  };
  return JSON.stringify(frame);
};

describe('connecting', () => {
  test('start opens one socket, and a second start opens no more', () => {
    const h = harness();
    h.connection.start();
    h.connection.start();
    expect(h.sockets).toHaveLength(1);
    expect(h.connection.status()).toBe('connecting');
  });

  test('is open once the socket says so', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    expect(h.connection.status()).toBe('open');
  });
});

describe('reconnecting', () => {
  test('a dropped socket is retried after the backoff, and backs off further each time', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.closed(1006);
    expect(h.connection.status()).toBe('waiting');
    expect(h.fireNext()).toBe(BACKOFF.baseMs / 2);

    h.last().handlers.closed(1006);
    expect(h.fireNext()).toBe(BACKOFF.baseMs);
    h.last().handlers.closed(1006);
    expect(h.fireNext()).toBe(BACKOFF.baseMs * 2);
    expect(h.sockets).toHaveLength(4);
  });

  test('the wait never exceeds the cap, however long the outage', () => {
    const h = harness(() => 1);
    h.connection.start();
    const waits: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      h.last().handlers.closed(1006);
      waits.push(h.fireNext());
    }
    expect(Math.max(...waits)).toBe(BACKOFF.capMs);
    expect(waits.at(-1)).toBe(BACKOFF.capMs);
  });

  test('a connection that stayed up long enough starts the backoff over', () => {
    const h = harness();
    h.connection.start();
    for (let i = 0; i < 3; i += 1) {
      h.last().handlers.closed(1006);
      h.fireNext();
    }
    h.last().handlers.opened();
    h.fireNext(); // the stability timer: the connection held
    h.last().handlers.closed(1006);
    expect(h.fireNext()).toBe(BACKOFF.baseMs / 2);
  });

  test('a connection that opens and drops at once does not start the backoff over', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    h.last().handlers.closed(1006); // before the stability timer
    expect(h.live().filter((timer) => timer.ms === BACKOFF.baseMs)).toHaveLength(1);
  });

  test.each([
    ['a restart', CLOSE_CODES.RESTARTING],
    ['falling behind', CLOSE_CODES.RESYNC],
    ['a network drop', 1006],
  ])('%s is reconnected from', (_name, code) => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed(code);
    expect(h.connection.status()).toBe('waiting');
    expect(h.live()).toHaveLength(1);
  });

  test('an ended session is not reconnected into a refusal', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed(CLOSE_CODES.SESSION_ENDED);
    expect(h.connection.status()).toBe('ended');
    expect(h.live()).toHaveLength(0);
    expect(h.sockets).toHaveLength(1);
  });

  test('a socket that cannot even be created is a failed attempt, not a crash', () => {
    const timers: number[] = [];
    const connection = createConnection({
      url: 'ws://test/ws',
      openSocket: () => {
        throw new Error('blocked');
      },
      schedule: (_fn, ms) => {
        timers.push(ms);
        return (): void => undefined;
      },
      random: () => 0,
      clock: { now: (): Date => new Date(T0) },
      serverClock: createServerClock({ now: (): Date => new Date(T0) }),
      checkSession: () => Promise.resolve('active'),
      newId: () => idAt(0),
      onFrame: () => undefined,
    });
    connection.start();
    expect(connection.status()).toBe('waiting');
    expect(timers).toEqual([BACKOFF.baseMs / 2]);
  });

  test('stop cancels a pending retry and ignores a late close from the old socket', () => {
    const h = harness();
    h.connection.start();
    const old = h.last();
    old.handlers.closed(1006);
    h.connection.stop();
    expect(h.live()).toHaveLength(0);
    expect(h.connection.status()).toBe('idle');

    old.handlers.closed(1006);
    expect(h.live()).toHaveLength(0);
  });
});

describe('a socket that has been replaced', () => {
  /**
   * A superseded socket can still deliver: its frames were in flight when the
   * connection moved on. Folding one in would advance a cursor past messages the new
   * connection's replay has yet to fetch — the gap `Connection` exists to close — and
   * would hand the UI a frame from a connection it no longer has.
   */
  test('its late frames are neither shown nor remembered once a newer socket exists', () => {
    const h = harness();
    h.connection.watch(channel(1));
    h.connection.start();
    const old = h.last();
    old.handlers.opened();
    old.handlers.closed(1006);
    h.fireNext();
    const current = h.last();
    expect(current).not.toBe(old);

    old.handlers.message(created(channel(1), idAt(9_000)));
    expect(h.frames).toEqual([]);

    // The control: the same frame on the current socket is shown.
    current.handlers.opened();
    current.handlers.message(created(channel(1), idAt(9_000)));
    expect(h.frames).toHaveLength(1);
  });

  test('its late frames do not advance the cursor the next connection resumes from', () => {
    const h = harness();
    h.connection.watch(channel(1));
    h.connection.start();
    const old = h.last();
    old.handlers.opened();
    old.handlers.closed(1006);
    h.fireNext();
    old.handlers.message(created(channel(1), idAt(9_000)));

    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels).toEqual([
      { channelId: channel(1), afterMessageId: null },
    ]);
  });

  test('after stop, a frame from the old socket is dropped', () => {
    const h = harness();
    h.connection.start();
    const old = h.last();
    old.handlers.opened();
    h.connection.stop();
    old.handlers.message(created(channel(1), idAt(1_000)));
    expect(h.frames).toEqual([]);
  });
});

describe('replay by cursor', () => {
  test('a channel nothing was heard in resubscribes from null', () => {
    const h = harness();
    h.connection.watch(channel(1));
    h.connection.start();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels).toEqual([
      { channelId: channel(1), afterMessageId: null },
    ]);
  });

  test('a reconnect names the highest id heard per channel', () => {
    const h = harness();
    h.connection.watch(channel(1));
    h.connection.watch(channel(2));
    h.connection.start();
    h.last().handlers.opened();

    const low = idAt(1_000);
    const high = idAt(5_000);
    h.last().handlers.message(created(channel(1), high));
    h.last().handlers.message(created(channel(1), low)); // out of order
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();

    const channels = h.subscribes(h.last())[0]?.payload.channels;
    expect(channels).toContainEqual({ channelId: channel(1), afterMessageId: high });
    expect(channels).toContainEqual({ channelId: channel(2), afterMessageId: null });
  });

  test('an id loaded some other way, such as a history page, moves the cursor', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const fromHistory = idAt(9_000);
    h.connection.observe(channel(1), fromHistory);
    h.connection.start();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels[0]?.afterMessageId).toBe(fromHistory);
  });

  test('more channels than one frame may name are split across frames, each once', () => {
    const h = harness();
    const total = SUBSCRIBE_MAX_CHANNELS + 30;
    for (let n = 1; n <= total; n += 1) h.connection.watch(channel(n));
    h.connection.start();
    h.last().handlers.opened();

    // One at a time: the second leaves when the first is acknowledged (pacing, below).
    const first = h.subscribes(h.last())[0];
    if (first === undefined) throw new Error('no SUBSCRIBE was sent');
    h.last().handlers.message(
      JSON.stringify({
        event: 'ACK',
        ts: T0,
        refId: first.id,
        data: {
          channels: first.payload.channels.map(({ channelId }) => ({
            channelId,
            nextCursor: null,
          })),
        },
      }),
    );
    const frames = h.subscribes(h.last());
    expect(frames.map((frame) => frame.payload.channels.length)).toEqual([
      SUBSCRIBE_MAX_CHANNELS,
      30,
    ]);
    const named = frames.flatMap((frame) => frame.payload.channels.map((c) => c.channelId));
    expect(new Set(named).size).toBe(total);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
  });

  test('channels unwatched together go in one frame, chunked at the frame bound (#523)', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    const many = Array.from({ length: SUBSCRIBE_MAX_CHANNELS + 2 }, (_, n) => channel(n + 1));
    for (const id of many) h.connection.watch(id);
    const before = h.last().sent.length;
    h.connection.unwatch(many);
    const frames = h
      .last()
      .sent.slice(before)
      .map((raw) => JSON.parse(raw) as ClientFrame);
    expect(frames.map((f) => f.op)).toEqual(['UNSUBSCRIBE', 'UNSUBSCRIBE']);
    expect(frames.flatMap((f) => (f.op === 'UNSUBSCRIBE' ? f.payload.channelIds : []))).toEqual(
      many,
    );
  });

  test('a channel the server already let go is forgotten without a frame, and not subscribed again (#523)', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.watch(channel(1));
    h.connection.watch(channel(2));
    const before = h.last().sent.length;
    h.connection.forget([channel(1), channel(2)]);
    expect(h.last().sent.length).toBe(before);
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())).toHaveLength(0);
  });

  test('nothing watched, nothing subscribed', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())).toEqual([]);
  });

  test('watching while open subscribes at once, and unwatching says so', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.watch(channel(1));
    expect(h.subscribes(h.last())).toHaveLength(1);

    h.connection.unwatch([channel(1)]);
    expect(JSON.parse(h.last().sent.at(-1) ?? '{}')).toMatchObject({
      op: 'UNSUBSCRIBE',
      payload: { channelIds: [channel(1)] },
    });

    // And a channel no longer watched is not resubscribed after a drop.
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())).toHaveLength(0);
  });

  test('watching twice subscribes once', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.connection.watch(channel(1));
    h.connection.watch(channel(1));
    expect(h.subscribes(h.last())).toHaveLength(1);
  });
});

describe('frames', () => {
  test('a frame the contract defines is passed on', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.message(JSON.stringify({ event: 'PONG', data: {}, ts: T0 }));
    expect(h.frames.map((frame) => frame.event)).toEqual(['PONG']);
  });

  test.each([
    ['text that is not a frame', 'garbage'],
    ['binary data', new ArrayBuffer(4)],
  ])('%s ends the connection rather than being guessed at', (_name, data) => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.message(data);
    expect(h.last().closedByClient).toBe(true);
    expect(h.frames).toEqual([]);
  });

  test('send reports whether the frame left', () => {
    const h = harness();
    const frame: ClientFrame = { id: idAt(0), op: 'PING', payload: {} };
    expect(h.connection.send(frame)).toBe(false);
    h.connection.start();
    expect(h.connection.send(frame)).toBe(false);
    h.last().handlers.opened();
    expect(h.connection.send(frame)).toBe(true);
    expect(JSON.parse(h.last().sent.at(-1) ?? '{}')).toEqual(frame);
  });

  test('status changes are reported once each, in order', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    h.last().handlers.closed(1006);
    h.fireNext();
    expect(h.statuses).toEqual(['connecting', 'open', 'waiting', 'connecting']);
  });
});

const pong = (refId: string | undefined, ts = T0): string =>
  JSON.stringify(
    refId === undefined ? { event: 'PONG', data: {}, ts } : { event: 'PONG', data: {}, ts, refId },
  );

/** Let a settled promise's continuation run. */
const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const openOne = (h: Harness): FakeSocket => {
  h.connection.start();
  h.last().handlers.opened();
  return h.last();
};

const waits = (h: Harness): number[] => h.live().map((timer) => timer.ms);

describe('the heartbeat', () => {
  test('a PING leaves as soon as the socket opens, so the clock is measured early', () => {
    const h = harness();
    const socket = openOne(h);
    expect(h.pings(socket)).toHaveLength(1);
  });

  test('silence past the deadline is a dead socket: closed, and reconnected without waiting for it', () => {
    const h = harness();
    const socket = openOne(h);
    h.fireWaiting(PONG_DEADLINE_MS);
    expect(socket.closedByClient).toBe(true);
    expect(h.connection.status()).toBe('waiting');
    expect(waits(h)).toEqual([BACKOFF.baseMs / 2]);

    // A half-open socket may announce its close minutes later; that must change nothing.
    socket.handlers.closed(1006);
    expect(h.live()).toHaveLength(1);
    h.fireNext();
    expect(h.sockets).toHaveLength(2);
  });

  test('an answer inside the deadline keeps the socket, and the next PING waits for idleness', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(pong(h.pings(socket)[0]?.id));
    expect(waits(h)).toEqual([STABLE_AFTER_MS, PING_AFTER_IDLE_MS]);

    h.fireWaiting(PING_AFTER_IDLE_MS);
    expect(h.pings(socket)).toHaveLength(2);
    expect(waits(h)).toContain(PONG_DEADLINE_MS);
  });

  test('any frame at all is proof of life, not only a PONG', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(created(channel(1), idAt(1_000)));
    expect(waits(h)).not.toContain(PONG_DEADLINE_MS);
    expect(waits(h)).toContain(PING_AFTER_IDLE_MS);
    expect(h.connection.status()).toBe('open');
  });

  test('an event this client does not know is also proof of life', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(JSON.stringify({ event: 'FROM_THE_FUTURE', data: {}, ts: T0 }));
    expect(waits(h)).not.toContain(PONG_DEADLINE_MS);
  });

  test('a frame that is malformed is not proof of life', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message('garbage');
    expect(waits(h)).toContain(PONG_DEADLINE_MS);
  });

  test('a dropped socket stops the heartbeat, and the next one starts its own', () => {
    const h = harness();
    const first = openOne(h);
    first.handlers.closed(1006);
    expect(waits(h)).toEqual([BACKOFF.baseMs / 2]);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.pings(h.last())).toHaveLength(1);
    expect(h.pings(first)).toHaveLength(1);
  });

  test('stop leaves no timer behind', () => {
    const h = harness();
    openOne(h);
    h.connection.stop();
    expect(h.live()).toHaveLength(0);
  });

  test('nothing is timed before the socket opens', () => {
    const h = harness();
    h.connection.start();
    expect(h.live()).toHaveLength(0);
  });
});

describe('the browser says the network went or came back (#626)', () => {
  test('gone while open: the socket is dead at once, not after a PING goes unanswered', () => {
    const h = harness();
    const socket = openOne(h);
    h.connection.networkLost();
    expect(socket.closedByClient).toBe(true);
    expect(h.connection.status()).toBe('waiting');
    // Its own close, when it comes, changes nothing.
    socket.handlers.closed(1006);
    expect(h.live()).toHaveLength(1);
  });

  test('gone while connecting: the attempt is given up and waits like any failed one', () => {
    const h = harness();
    h.connection.start();
    const attempt = h.last();
    h.connection.networkLost();
    expect(attempt.closedByClient).toBe(true);
    expect(h.connection.status()).toBe('waiting');
    attempt.handlers.opened();
    expect(h.connection.status()).toBe('waiting');
  });

  test('back while waiting: the wait it was in is cut to the first rung, jittered', () => {
    const h = harness();
    const socket = openOne(h);
    // A long outage: the backoff has climbed to its cap.
    for (let i = 0; i < 12; i += 1) {
      h.last().handlers.closed(1006);
      h.fireNext();
    }
    h.last().handlers.closed(1006);
    expect(waits(h)).toEqual([reconnectDelay(13, () => 0)]);
    expect(waits(h)[0]).toBeGreaterThan(reconnectDelay(0, () => 1));
    h.connection.networkBack();
    // Not at once: a network back for every page on it at the same moment is a herd, so each
    // waits the first rung's jittered half-second to a second (D-76).
    expect(waits(h)).toEqual([reconnectDelay(0, () => 0)]);
    expect(h.connection.status()).toBe('waiting');
    h.fireNext();
    expect(h.connection.status()).toBe('connecting');
    expect(socket.closedByClient).toBe(false);
  });

  test('back, and the first attempt fails: the next wait is the second rung, not the cap', () => {
    const h = harness();
    openOne(h);
    for (let i = 0; i < 12; i += 1) {
      h.last().handlers.closed(1006);
      h.fireNext();
    }
    h.last().handlers.closed(1006);
    h.connection.networkBack();
    h.fireNext();
    // The browser often says online before the route works: that attempt fails.
    h.last().handlers.closed(1006);
    expect(waits(h)).toEqual([reconnectDelay(1, () => 0)]);
  });

  test('back while open: a PING asks at once whether the socket lived through it', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(pong(h.pings(socket)[0]?.id));
    expect(waits(h)).not.toContain(PONG_DEADLINE_MS);
    h.connection.networkBack();
    expect(h.pings(socket)).toHaveLength(2);
    expect(waits(h)).toContain(PONG_DEADLINE_MS);
    // A socket that did not live through it is found dead by the usual deadline.
    h.fireWaiting(PONG_DEADLINE_MS);
    expect(socket.closedByClient).toBe(true);
  });

  test('back while open with a PING already out sends no second one', () => {
    const h = harness();
    const socket = openOne(h);
    h.connection.networkBack();
    expect(h.pings(socket)).toHaveLength(1);
  });

  test('back while an attempt hangs: it is given up, and tried again from the first rung', () => {
    const h = harness();
    h.connection.start();
    const hung = h.last();
    h.connection.networkBack();
    expect(hung.closedByClient).toBe(true);
    expect(waits(h)).toEqual([reconnectDelay(0, () => 0)]);
    // Its answer, if it ever comes, changes nothing.
    hung.handlers.opened();
    expect(h.connection.status()).toBe('waiting');
    h.fireNext();
    expect(h.sockets).toHaveLength(2);
  });

  test('neither starts a connection that was never started, was stopped, or ended', () => {
    const idle = harness();
    idle.connection.networkLost();
    idle.connection.networkBack();
    expect(idle.sockets).toHaveLength(0);
    expect(idle.connection.status()).toBe('idle');

    const stopped = harness();
    openOne(stopped);
    stopped.connection.stop();
    stopped.connection.networkBack();
    expect(stopped.sockets).toHaveLength(1);
    expect(stopped.connection.status()).toBe('idle');

    const ended = harness();
    openOne(ended).handlers.closed(CLOSE_CODES.SESSION_ENDED);
    ended.connection.networkLost();
    ended.connection.networkBack();
    expect(ended.sockets).toHaveLength(1);
    expect(ended.connection.status()).toBe('ended');
  });

  test('gone while already waiting does not count another failure', () => {
    const h = harness();
    openOne(h).handlers.closed(1006);
    const before = waits(h);
    h.connection.networkLost();
    expect(waits(h)).toEqual(before);
  });
});

describe('the first PONG sets the server clock', () => {
  test('its midpoint against the local clock becomes the offset', () => {
    const h = harness();
    const socket = openOne(h);
    const ping = h.pings(socket)[0];
    h.local.advance(200); // the round trip
    socket.handlers.message(pong(ping?.id, T0 + 100 + 5_000));
    expect(h.serverClock.corrected()).toBe(true);
    expect(h.serverClock.now().getTime()).toBe(T0 + 200 + 5_000);
  });

  test('a PONG that answers no PING of ours is not a sample', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(pong(undefined, T0 + 9_000));
    socket.handlers.message(pong(idAt(77_000), T0 + 9_000));
    expect(h.serverClock.corrected()).toBe(false);
  });

  test('a local clock that ran backwards during the round trip is skipped, then measured again', () => {
    const h = harness();
    const socket = openOne(h);
    h.local.advance(-1_000);
    socket.handlers.message(pong(h.pings(socket)[0]?.id, T0));
    expect(h.serverClock.corrected()).toBe(false);
    expect(h.connection.status()).toBe('open');

    h.fireWaiting(PING_AFTER_IDLE_MS);
    h.local.advance(100);
    socket.handlers.message(pong(h.pings(socket)[1]?.id, T0 + 3_000));
    expect(h.serverClock.corrected()).toBe(true);
  });

  test('once corrected, a later PONG does not move it', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(pong(h.pings(socket)[0]?.id, T0 + 5_000));
    const corrected = h.serverClock.now().getTime();
    h.fireWaiting(PING_AFTER_IDLE_MS);
    socket.handlers.message(pong(h.pings(socket)[1]?.id, T0 + 99_000));
    expect(h.serverClock.now().getTime()).toBe(corrected);
  });
});

describe('a refusal is not an outage', () => {
  /** `times` handshakes in a row that never reached `open`. */
  const failTimes = (h: Harness, times: number): void => {
    h.connection.start();
    for (let i = 0; i < times; i += 1) {
      h.last().handlers.closed(1006);
      if (i < times - 1) h.fireNext();
    }
  };

  test('before enough failures, nobody is asked', () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES - 1);
    expect(h.checks).toHaveLength(0);
  });

  test('after repeated failures that never reached open, the session is asked about', () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    expect(h.checks).toHaveLength(1);
  });

  test('a session that has ended stops the retrying', async () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.checks[0]?.resolve('ended');
    await settle();
    expect(h.connection.status()).toBe('ended');
    expect(h.live()).toHaveLength(0);
    expect(h.sockets).toHaveLength(CHECK_SESSION_AFTER_FAILURES);
  });

  test.each([
    ['active', 'the session is fine, so this is an outage'],
    ['unknown', 'the answer is a 5xx or a network error'],
  ] as const)('%s: retrying goes on (%s)', async (answer) => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.checks[0]?.resolve(answer);
    await settle();
    expect(h.connection.status()).toBe('waiting');
    expect(h.live()).toHaveLength(1);
  });

  test('a check that itself fails is an outage too', async () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.checks[0]?.reject();
    await settle();
    expect(h.connection.status()).toBe('waiting');
    expect(h.live()).toHaveLength(1);
  });

  test('only one check is in flight at a time', () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES + 2);
    expect(h.checks).toHaveLength(1);
  });

  test('having reached open once, the count starts over', () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES - 1);
    h.fireNext();
    h.last().handlers.opened();
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.closed(1006);
    expect(h.checks).toHaveLength(0);
  });

  test('an answer that arrives after the connection recovered is ignored', async () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.fireNext(); // the retry goes out while the check is still in flight
    h.last().handlers.opened();
    h.checks[0]?.resolve('ended');
    await settle();
    expect(h.connection.status()).toBe('open');
  });

  test('an answer that arrives after stop is ignored', async () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.connection.stop();
    h.checks[0]?.resolve('ended');
    await settle();
    expect(h.connection.status()).toBe('idle');
  });

  test('once answered, a later failure asks again', async () => {
    const h = harness();
    failTimes(h, CHECK_SESSION_AFTER_FAILURES);
    h.checks[0]?.resolve('active');
    await settle();
    h.fireNext();
    h.last().handlers.closed(1006);
    expect(h.checks).toHaveLength(2);
  });
});

describe('an ended session', () => {
  test('forgets its failures, and start works again from it', () => {
    const h = harness();
    h.connection.start();
    for (let i = 0; i < 3; i += 1) {
      h.last().handlers.closed(1006);
      h.fireNext();
    }
    h.last().handlers.closed(CLOSE_CODES.SESSION_ENDED);
    expect(h.connection.status()).toBe('ended');

    h.connection.watch(channel(1));
    h.connection.start();
    expect(h.connection.status()).toBe('connecting');
    h.last().handlers.opened();
    expect(h.subscribes(h.last())).toHaveLength(1);

    h.last().handlers.closed(1006);
    expect(h.fireNext()).toBe(BACKOFF.baseMs / 2); // not 4 s: the old failures are gone
  });

  test('ended by a check, it too can be started again, with the count started over', async () => {
    const h = harness();
    h.connection.start();
    for (let i = 0; i < CHECK_SESSION_AFTER_FAILURES; i += 1) {
      h.last().handlers.closed(1006);
      if (i < CHECK_SESSION_AFTER_FAILURES - 1) h.fireNext();
    }
    h.checks[0]?.resolve('ended');
    await settle();
    h.connection.start();
    expect(h.connection.status()).toBe('connecting');
    h.last().handlers.closed(1006);
    expect(h.checks).toHaveLength(1);
  });
});

describe('an event from a newer server', () => {
  test('is ignored: not passed on, and the connection stays', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(JSON.stringify({ event: 'REACTION_ADDED', data: { x: 1 }, ts: T0 }));
    expect(socket.closedByClient).toBe(false);
    expect(h.frames).toEqual([]);
    expect(h.connection.status()).toBe('open');
  });

  test('a known event with the wrong data still ends the connection', () => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(JSON.stringify({ event: 'ACK', data: { id: 5 }, ts: T0 }));
    expect(socket.closedByClient).toBe(true);
  });

  test.each([
    ['an object with no event', JSON.stringify({ data: {}, ts: T0 })],
    ['a JSON array', '[]'],
  ])('%s still ends the connection', (_name, text) => {
    const h = harness();
    const socket = openOne(h);
    socket.handlers.message(text);
    expect(socket.closedByClient).toBe(true);
  });
});

describe('the cursor and a replay that was one page', () => {
  const subscribed = (channelId: string, nextCursor: string | null): string =>
    JSON.stringify({ event: 'ACK', ts: T0, data: { channels: [{ channelId, nextCursor }] } });

  test('a replay with more to come is reported as pending, with where to continue', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    const page = idAt(2_000);
    socket.handlers.message(subscribed(channel(1), page));
    expect([...h.connection.pendingContinuations()]).toEqual([[channel(1), page]]);
  });

  test('a replay that reached the present is not pending', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    socket.handlers.message(subscribed(channel(1), idAt(2_000)));
    socket.handlers.message(subscribed(channel(1), null));
    expect(h.connection.pendingContinuations().size).toBe(0);
  });

  test('while pending, a live frame beyond the page does not move the cursor', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    const page = idAt(2_000);
    socket.handlers.message(subscribed(channel(1), page));
    socket.handlers.message(created(channel(1), idAt(1_000)));
    socket.handlers.message(created(channel(1), page));
    socket.handlers.message(created(channel(1), idAt(9_000))); // live, past the gap

    socket.handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels[0]?.afterMessageId).toBe(page);
  });

  test('the live frame is still delivered, only its place in the cursor is withheld', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    socket.handlers.message(subscribed(channel(1), idAt(2_000)));
    socket.handlers.message(created(channel(1), idAt(9_000)));
    expect(h.frames.filter((frame) => frame.event === 'MESSAGE_CREATED')).toHaveLength(1);
  });

  test('pages fetched over HTTP move the cursor, and finishing lets live frames count again', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    const page = idAt(2_000);
    socket.handlers.message(subscribed(channel(1), page));

    h.connection.observe(channel(1), idAt(5_000)); // the continuation, reaching the present
    h.connection.continuationDone(channel(1), page);
    expect(h.connection.pendingContinuations().size).toBe(0);

    const live = idAt(9_000);
    socket.handlers.message(created(channel(1), live));
    socket.handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels[0]?.afterMessageId).toBe(live);
  });

  test('finishing a continuation that is not the current one changes nothing', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    const page = idAt(2_000);
    socket.handlers.message(subscribed(channel(1), page));
    h.connection.continuationDone(channel(1), idAt(1_000)); // an older replay's
    expect(h.connection.pendingContinuations().get(channel(1))).toBe(page);
  });

  test('a new connection starts from what its own replay says, not the last one', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    socket.handlers.message(subscribed(channel(1), idAt(2_000)));
    socket.handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.connection.pendingContinuations().size).toBe(0);

    const live = idAt(9_000);
    h.last().handlers.message(subscribed(channel(1), null));
    h.last().handlers.message(created(channel(1), live));
    h.last().handlers.closed(1006);
    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())[0]?.payload.channels[0]?.afterMessageId).toBe(live);
  });

  test('a channel no longer watched has nothing pending', () => {
    const h = harness();
    h.connection.watch(channel(1));
    const socket = openOne(h);
    socket.handlers.message(subscribed(channel(1), idAt(2_000)));
    h.connection.unwatch([channel(1)]);
    expect(h.connection.pendingContinuations().size).toBe(0);
  });
});

/** The wait before a chunk is sent again: the one live timer that is not the heartbeat's or the backoff's forgiveness. */
const retryTimer = (h: Harness): Harness['timers'][number] | undefined =>
  h.live().find((t) => ![STABLE_AFTER_MS, PONG_DEADLINE_MS, PING_AFTER_IDLE_MS].includes(t.ms));

describe('pacing a large subscription', () => {
  const ackFor = (chunk: SubscribeFrame): string =>
    JSON.stringify({
      event: 'ACK',
      ts: T0,
      refId: chunk.id,
      data: {
        channels: chunk.payload.channels.map(({ channelId }) => ({ channelId, nextCursor: null })),
      },
    });
  const limited = (refId: string): string =>
    JSON.stringify({
      event: 'ERROR',
      ts: T0,
      refId,
      data: { code: 'RATE_LIMITED', message: 'slow down' },
    });
  const watchMany = (h: Harness, total: number): void => {
    for (let n = 1; n <= total; n += 1) h.connection.watch(channel(n));
  };
  const chunksOf = (total: number): number => Math.ceil(total / SUBSCRIBE_MAX_CHANNELS);

  test('only one chunk is in flight; the next leaves when the last is acknowledged', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS * 3 + 5);
    const socket = openOne(h);
    expect(h.subscribes(socket)).toHaveLength(1);

    for (let sent = 1; sent <= 3; sent += 1) {
      const chunk = h.subscribes(socket)[sent - 1];
      if (chunk === undefined) throw new Error('chunk missing');
      socket.handlers.message(ackFor(chunk));
      expect(h.subscribes(socket)).toHaveLength(sent + 1);
    }
    const sizes = h.subscribes(socket).map((frame) => frame.payload.channels.length);
    expect(sizes).toEqual([
      SUBSCRIBE_MAX_CHANNELS,
      SUBSCRIBE_MAX_CHANNELS,
      SUBSCRIBE_MAX_CHANNELS,
      5,
    ]);
    const named = h
      .subscribes(socket)
      .flatMap((frame) => frame.payload.channels.map((c) => c.channelId));
    expect(new Set(named).size).toBe(SUBSCRIBE_MAX_CHANNELS * 3 + 5);
  });

  test('a RATE_LIMITED answer is retried after a wait, with the same channels', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(limited(first.id));
    expect(h.subscribes(socket)).toHaveLength(1); // not at once

    const wait = retryTimer(h);
    if (wait === undefined) throw new Error('no retry scheduled');
    wait.live = false;
    wait.fn();
    const retry = h.subscribes(socket)[1];
    expect(retry?.payload.channels).toEqual(first.payload.channels);
    expect(retry?.id).not.toBe(first.id);
  });

  test('a database that is busy is retried the same way', () => {
    const h = harness();
    watchMany(h, 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(
      JSON.stringify({
        event: 'ERROR',
        ts: T0,
        refId: first.id,
        data: { code: 'DATABASE_UNAVAILABLE', message: 'busy' },
      }),
    );
    expect(retryTimer(h)).toBeDefined();
  });

  test('a channel unwatched during the wait is not sent when the wait ends', () => {
    const h = harness();
    watchMany(h, 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(limited(first.id));
    h.connection.unwatch([channel(1)]);
    const wait = retryTimer(h);
    if (wait === undefined) throw new Error('no retry scheduled');
    wait.live = false;
    wait.fn();
    expect(h.subscribes(socket)).toHaveLength(1);
  });

  test('an answer to something else does not release the chunk on the wire', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(ackFor({ ...first, id: idAt(88_000) }));
    expect(h.subscribes(socket)).toHaveLength(1);
  });

  test('an acknowledgement starts the wait over', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(limited(first.id));
    const wait = retryTimer(h);
    if (wait === undefined) throw new Error('no retry scheduled');
    wait.live = false;
    wait.fn();
    const second = h.subscribes(socket)[1];
    if (second === undefined) throw new Error('retry missing');
    socket.handlers.message(ackFor(second));
    const third = h.subscribes(socket)[2];
    if (third === undefined) throw new Error('next chunk missing');
    socket.handlers.message(limited(third.id));
    expect(retryTimer(h)?.ms).toBe(BACKOFF.baseMs / 2);
  });

  test('the wait grows while the answer stays RATE_LIMITED', () => {
    const h = harness();
    watchMany(h, 1);
    const socket = openOne(h);
    const waitsSeen: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const chunk = h.subscribes(socket).at(-1);
      if (chunk === undefined) throw new Error('chunk missing');
      socket.handlers.message(limited(chunk.id));
      const timer = retryTimer(h);
      if (timer === undefined) throw new Error('no retry scheduled');
      waitsSeen.push(timer.ms);
      timer.live = false;
      timer.fn();
    }
    expect(waitsSeen).toEqual([BACKOFF.baseMs / 2, BACKOFF.baseMs, BACKOFF.baseMs * 2]);
  });

  test('another error for a chunk is not retried, and the rest still go', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(
      JSON.stringify({
        event: 'ERROR',
        ts: T0,
        refId: first.id,
        data: { code: 'WORKSPACE_NOT_FOUND', message: 'no such channel' },
      }),
    );
    expect(h.subscribes(socket)).toHaveLength(2);
    expect(h.subscribes(socket)[1]?.payload.channels).toHaveLength(1);
  });

  test('a channel unwatched while it waits for its turn is not subscribed', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    h.connection.unwatch([channel(SUBSCRIBE_MAX_CHANNELS + 1)]);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(ackFor(first));
    expect(h.subscribes(socket)).toHaveLength(1);
  });

  test('watching while a chunk is in flight waits behind it', () => {
    const h = harness();
    watchMany(h, 1);
    const socket = openOne(h);
    h.connection.watch(channel(500));
    expect(h.subscribes(socket)).toHaveLength(1);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(ackFor(first));
    expect(h.subscribes(socket)[1]?.payload.channels).toEqual([
      { channelId: channel(500), afterMessageId: null },
    ]);
  });

  test('a reconnect starts the whole subscription over, and a pending retry dies with the socket', () => {
    const h = harness();
    watchMany(h, SUBSCRIBE_MAX_CHANNELS + 1);
    const socket = openOne(h);
    const first = h.subscribes(socket)[0];
    if (first === undefined) throw new Error('chunk missing');
    socket.handlers.message(limited(first.id));
    socket.handlers.closed(1006);
    expect(h.live().map((t) => t.ms)).toEqual([BACKOFF.baseMs / 2]);

    h.fireNext();
    h.last().handlers.opened();
    expect(h.subscribes(h.last())).toHaveLength(1);
    expect(h.subscribes(h.last())[0]?.payload.channels).toHaveLength(SUBSCRIBE_MAX_CHANNELS);
    expect(h.subscribes(socket)).toHaveLength(1);
  });

  test('TOO_BUSY waits longer than an ordinary drop before reconnecting', () => {
    const h = harness();
    openOne(h).handlers.closed(CLOSE_CODES.TOO_BUSY);
    expect(h.fireNext()).toBe(reconnectDelay(TOO_BUSY_BACKOFF_STEP, () => 0));
    expect(reconnectDelay(TOO_BUSY_BACKOFF_STEP, () => 0)).toBeGreaterThan(BACKOFF.baseMs);
  });

  test('TOO_BUSY never shortens a wait the failures had already earned', () => {
    const h = harness();
    h.connection.start();
    for (let i = 0; i < TOO_BUSY_BACKOFF_STEP + 2; i += 1) {
      h.last().handlers.closed(1006);
      h.fireNext();
    }
    h.last().handlers.closed(CLOSE_CODES.TOO_BUSY);
    expect(h.fireNext()).toBe(reconnectDelay(TOO_BUSY_BACKOFF_STEP + 2, () => 0));
  });

  describe('against a server that limits and closes like the real one', () => {
    // The real limits live in apps/api (`SOCKET_FRAME_BUDGET`, `FRAME_QUEUE_MAX`); the
    // client must not import them, so this model states what it relies on: a burst
    // of 20 that refills with time, and a close with 1013 when more than 32 frames
    // are waiting to be handled at once.
    const BURST = 20;
    const QUEUE_MAX = 32;
    const REFILL_PER_SECOND = 10;

    const runAgainstServer = (total: number): { acked: Set<string>; tooBusy: number } => {
      const h = harness();
      watchMany(h, total);
      const acked = new Set<string>();
      let tooBusy = 0;
      let tokens = BURST;
      let handled = 0;

      /** The server takes what has arrived: all of it at once, as the socket delivers it. */
      const serve = (socket: FakeSocket): void => {
        const arrived = socket.sent.slice(handled);
        if (arrived.length > QUEUE_MAX) {
          tooBusy += 1;
          handled = socket.sent.length;
          socket.handlers.closed(CLOSE_CODES.TOO_BUSY);
          return;
        }
        handled = socket.sent.length;
        for (const text of arrived) {
          const frame: unknown = JSON.parse(text);
          if (!isSubscribe(frame)) continue;
          if (tokens < 1) {
            socket.handlers.message(limited(frame.id));
          } else {
            tokens -= 1;
            for (const { channelId } of frame.payload.channels) acked.add(channelId);
            socket.handlers.message(ackFor(frame));
          }
        }
        if (socket.sent.length > handled) serve(socket);
      };

      let socket = openOne(h);
      tokens -= 1; // the PING sent as the socket opened
      for (let turns = 0; turns < 400 && acked.size < total; turns += 1) {
        serve(socket);
        if (acked.size >= total) break;
        const timer = retryTimer(h);
        if (timer === undefined) break;
        tokens = Math.min(BURST, tokens + (timer.ms / 1000) * REFILL_PER_SECOND);
        const before = h.sockets.length;
        timer.live = false;
        timer.fn();
        if (h.sockets.length > before) {
          socket = h.last();
          socket.handlers.opened();
          handled = 0;
        }
      }
      return { acked, tooBusy };
    };

    test('2,500 channels: every chunk is eventually acknowledged', () => {
      const result = runAgainstServer(2_500);
      expect(chunksOf(2_500)).toBe(25);
      expect(result.acked.size).toBe(2_500);
      expect(result.tooBusy).toBe(0);
    });

    test('3,500 channels: no close for being too busy, and every channel subscribed', () => {
      const result = runAgainstServer(3_500);
      expect(result.tooBusy).toBe(0);
      expect(result.acked.size).toBe(3_500);
    });
  });
});
