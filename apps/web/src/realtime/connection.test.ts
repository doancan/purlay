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
import {
  createConnection,
  type Connection,
  type OpenSocket,
  type SocketHandlers,
} from './connection';

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const idAt = (offsetMs: number): string => messageId(new Date(T0 + offsetMs));
const channel = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

type SubscribeFrame = Extract<ClientFrame, { op: 'SUBSCRIBE' }>;

const isSubscribe = (frame: unknown): frame is SubscribeFrame =>
  typeof frame === 'object' && frame !== null && 'op' in frame && frame.op === 'SUBSCRIBE';

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
}

const harness = (random = (): number => 0): Harness => {
  const sockets: FakeSocket[] = [];
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const frames: ServerFrame[] = [];
  const statuses: string[] = [];
  let counter = 0;

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

  return { connection, sockets, timers, frames, statuses, live, subscribes, last, fireNext };
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

  test('nothing watched, nothing sent', () => {
    const h = harness();
    h.connection.start();
    h.last().handlers.opened();
    expect(h.last().sent).toEqual([]);
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
    expect(JSON.parse(h.last().sent[0] ?? '{}')).toEqual(frame);
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
