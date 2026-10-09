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
import { BACKOFF } from './backoff';
import type { Clock } from './clock';
import {
  CHECK_SESSION_AFTER_FAILURES,
  PING_AFTER_IDLE_MS,
  PONG_DEADLINE_MS,
  STABLE_AFTER_MS,
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
      content: 'hi',
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(T0).toISOString(),
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

    const frames = h.subscribes(h.last());
    expect(frames.map((frame) => frame.payload.channels.length)).toEqual([
      SUBSCRIBE_MAX_CHANNELS,
      30,
    ]);
    const named = frames.flatMap((frame) => frame.payload.channels.map((c) => c.channelId));
    expect(new Set(named).size).toBe(total);
    expect(new Set(frames.map((frame) => frame.id)).size).toBe(2);
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

    h.connection.unwatch(channel(1));
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
    h.connection.unwatch(channel(1));
    expect(h.connection.pendingContinuations().size).toBe(0);
  });
});
