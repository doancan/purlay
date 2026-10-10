/**
 * What a person's own send does between the keystroke and the acknowledgement, and what
 * every frame means to the cache — against a socket and timers driven by hand.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  CLOSE_CODES,
  type Channel,
  type Message,
  type MessagePage,
  type ServerFrame,
} from '@purlay/types';
import { ApiError } from '../data/errors';
import { keys } from '../data/keys';
import { anApi } from '../testing/fake-api';
import { fakeSchedule } from '../testing/fakes';
import type { Api } from '../data/api';
import type { Clock } from './clock';
import type { SocketHandlers } from './connection';
import { ACK_DEADLINE_MS, createEngine, type Engine, type PendingMessage } from './engine';

type Pages = InfiniteData<MessagePage, string | undefined>;

const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const C1 = '0199155c-6200-7b7f-8c11-0000000000d1';
const C2 = '0199155c-6200-7b7f-8c11-0000000000d2';
const CH = '00000000-0000-4000-8000-0000000000c1';
const CH2 = '00000000-0000-4000-8000-0000000000c2';
const WS = '00000000-0000-4000-8000-0000000000a1';
const ME = {
  id: '00000000-0000-4000-8000-0000000000e1',
  username: 'me',
  displayName: 'Me',
  avatarUrl: null,
};
const summary = {
  replyCount: 1,
  lastReplyAt: '2026-10-09T12:00:01.000Z',
  resolvedAt: null,
  resolvedBy: null,
};

const echo = (id: string, over: Partial<Message> = {}): Message => ({
  id,
  channelId: CH,
  sender: ME,
  content: 'hello',
  editedAt: null,
  deletedAt: null,
  createdAt: '2026-10-09T12:00:00.000Z',
  parentId: null,
  thread: summary,
  reactions: [],
  mentions: [],
  ...over,
});
const channel = (id: string, over: Partial<Channel> = {}): Channel => ({
  id,
  workspaceId: WS,
  name: 'api',
  topic: null,
  type: 'public',
  lastMessageAt: null,
  state: { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 },
  peer: null,
  ...over,
});

interface Socket {
  readonly handlers: SocketHandlers;
  readonly sent: string[];
  closed: boolean;
}

interface World {
  readonly engine: Engine;
  readonly client: QueryClient;
  readonly timers: ReturnType<typeof fakeSchedule>;
  readonly sockets: Socket[];
  readonly ended: { count: number };
  readonly deliver: (frame: ServerFrame) => void;
  /** The frames of one operation the client sent over the socket, parsed. */
  readonly sentOps: (op: string) => { id: string; op: string; payload: Record<string, unknown> }[];
  readonly open: () => void;
  readonly pending: () => readonly PendingMessage[];
}

const world = (api: Partial<Api> = {}): World => {
  const timers = fakeSchedule();
  const sockets: Socket[] = [];
  const client = new QueryClient();
  const ended = { count: 0 };
  const clock: Clock = { now: () => new Date(T0) };
  const engine = createEngine({
    api: anApi(api),
    client,
    url: 'ws://purlay.test/ws',
    openSocket: (_url, handlers) => {
      const socket: Socket = { handlers, sent: [], closed: false };
      sockets.push(socket);
      return {
        send: (text): void => {
          socket.sent.push(text);
        },
        close: (): void => {
          socket.closed = true;
        },
      };
    },
    schedule: timers.schedule,
    random: () => 0.5,
    clock,
    onSessionEnded: () => {
      ended.count += 1;
    },
  });
  const last = (): Socket => {
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket was opened');
    return socket;
  };
  return {
    engine,
    client,
    timers,
    sockets,
    ended,
    deliver: (frame): void => {
      last().handlers.message(JSON.stringify(frame));
    },
    sentOps: (op) =>
      sockets
        .flatMap((s) =>
          s.sent.map(
            (text) =>
              JSON.parse(text) as { id: string; op: string; payload: Record<string, unknown> },
          ),
        )
        .filter((f) => f.op === op),
    open: (): void => {
      last().handlers.opened();
    },
    pending: (): readonly PendingMessage[] => engine.store.getState().pending,
  };
};

/**
 * The server answering every SUBSCRIBE and UNSUBSCRIBE the client has sent: the connection
 * sends the next chunk only after the last was answered, so a test that does not answer
 * never sees the second one.
 */
const answered = new Set<string>();
const answerAll = (w: World, cursors: Readonly<Record<string, string>> = {}): void => {
  for (const op of ['SUBSCRIBE', 'UNSUBSCRIBE'] as const) {
    for (const sent of w.sentOps(op)) {
      if (answered.has(sent.id)) continue;
      answered.add(sent.id);
      if (op === 'SUBSCRIBE') {
        const ids = (sent.payload['channels'] as { channelId: string }[]).map((c) => c.channelId);
        w.deliver({
          event: 'ACK',
          data: {
            channels: ids.map((channelId) => ({
              channelId,
              nextCursor: cursors[channelId] ?? null,
            })),
          },
          refId: sent.id,
          ts: T0,
        });
      } else {
        w.deliver({
          event: 'ACK',
          data: { channelIds: sent.payload['channelIds'] as string[] },
          refId: sent.id,
          ts: T0,
        });
      }
    }
  }
};

const ack = (id: string, refId = id): ServerFrame => ({
  event: 'ACK',
  data: { id },
  refId,
  ts: T0,
});
const frame = (f: ServerFrame): ServerFrame => f;

describe('a send over an open socket', () => {
  test('is on screen as sending before anything leaves, then goes out as one frame with the id it keeps', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello' });
    expect(w.pending()).toEqual([
      {
        id,
        channelId: CH,
        parentId: null,
        content: 'hello',
        createdAt: '2026-10-09T12:00:00.000Z',
        delivery: 'sending',
        reason: null,
      },
    ]);
    expect(w.sentOps('MESSAGE_SEND')).toEqual([
      { id, op: 'MESSAGE_SEND', payload: { channelId: CH, content: 'hello' } },
    ]);
  });

  test('a reply names its root', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'answer', parentId: 'root-1' });
    expect(w.sentOps('MESSAGE_SEND')[0]?.payload).toEqual({
      channelId: CH,
      content: 'answer',
      parentId: 'root-1',
    });
    expect(w.pending()[0]).toMatchObject({ id, parentId: 'root-1' });
  });

  test('the ACK marks it sent, and the echo teaches the cache and retires the pending row', () => {
    const w = world();
    w.client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [], nextCursor: null }],
    });
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello' });
    w.deliver(ack(id));
    expect(w.pending()[0]?.delivery).toBe('sent');
    w.deliver(frame({ event: 'MESSAGE_CREATED', data: echo(id), ts: T0 }));
    expect(w.pending()).toEqual([]);
    expect(w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0]?.id).toBe(id);
    expect(w.timers.pending()).toBeGreaterThanOrEqual(0);
  });

  test('an ACK for a message nobody is waiting on changes nothing', () => {
    const w = world();
    w.engine.start();
    w.open();
    w.deliver(ack('0199155c-6200-7b7f-8c11-000000000099'));
    expect(w.pending()).toEqual([]);
  });

  test('no ACK in three seconds is failed, never dropped; Retry sends the same id again', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello' });
    w.timers.advance(ACK_DEADLINE_MS - 1);
    expect(w.pending()[0]?.delivery).toBe('sending');
    w.timers.advance(1);
    expect(w.pending()[0]).toMatchObject({
      delivery: 'failed',
      reason: 'The server did not answer in time.',
    });

    w.engine.retry(id);
    expect(w.pending()[0]).toMatchObject({ id, delivery: 'sending', reason: null });
    const sends = w.sentOps('MESSAGE_SEND');
    expect(sends.map((s) => s.id)).toEqual([id, id]);
    w.deliver(ack(id));
    w.timers.advance(ACK_DEADLINE_MS * 2);
    expect(w.pending()[0]?.delivery).toBe('sent');
  });

  test("an ERROR that names the send fails it with the server's words; one that names nothing is ignored", () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello' });
    w.deliver(
      frame({ event: 'ERROR', data: { code: 'RATE_LIMITED', message: 'Slow down.' }, ts: T0 }),
    );
    expect(w.pending()[0]?.delivery).toBe('sending');
    w.deliver(
      frame({
        event: 'ERROR',
        data: { code: 'RATE_LIMITED', message: 'Slow down.' },
        refId: id,
        ts: T0,
      }),
    );
    expect(w.pending()[0]).toMatchObject({ delivery: 'failed', reason: 'Slow down.' });
  });

  test('only a failed message can be retried or discarded', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello' });
    w.engine.retry(id);
    w.engine.discard(id);
    expect(w.pending()).toHaveLength(1);
    expect(w.sentOps('MESSAGE_SEND')).toHaveLength(1);
    w.engine.retry('nobody');
    w.timers.advance(ACK_DEADLINE_MS);
    w.engine.discard(id);
    expect(w.pending()).toEqual([]);
  });
});

describe('a send while the socket is down goes over HTTP, the same service', () => {
  test('a success teaches the cache and retires the row', async () => {
    const sent: unknown[] = [];
    const w = world({
      send: (channelId, input) => {
        sent.push({ channelId, ...input });
        return Promise.resolve(echo(input.id));
      },
    });
    w.client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [], nextCursor: null }],
    });
    const id = w.engine.send({ channelId: CH, content: 'offline hello', parentId: 'root-1' });
    expect(w.pending()[0]?.delivery).toBe('sending');
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ channelId: CH, id, content: 'offline hello', parentId: 'root-1' }]);
    expect(w.pending()).toEqual([]);
    expect(w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data).toHaveLength(1);
  });

  test("a refusal is failed with the server's words; anything else with ours", async () => {
    let refuse: Error = new ApiError(400, 'VALIDATION_FAILED', 'Too long.');
    const w = world({ send: () => Promise.reject(refuse) });
    const first = w.engine.send({ channelId: CH, content: 'x' });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.pending().find((p) => p.id === first)).toMatchObject({
      delivery: 'failed',
      reason: 'Too long.',
    });
    refuse = new Error('boom');
    const second = w.engine.send({ channelId: CH, content: 'y' });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.pending().find((p) => p.id === second)).toMatchObject({
      delivery: 'failed',
      reason: 'The message could not be sent.',
    });
  });

  test('a send that failed on a row that was already discarded does not bring it back', async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const w = world({
      send: () =>
        new Promise((_resolve, rej) => {
          reject = rej;
        }),
    });
    const id = w.engine.send({ channelId: CH, content: 'x' });
    w.engine.discard(id); // not failed yet: ignored
    reject(new ApiError(500, 'INTERNAL', 'Something went wrong.'));
    await Promise.resolve();
    await Promise.resolve();
    w.engine.discard(id);
    expect(w.pending()).toEqual([]);
  });
});

describe('a reconnect', () => {
  test('re-sends what never got an answer, leaves failed ones for the person, and asks for what it missed', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.client.setQueryData(keys.thread('root'), { pageParams: [], pages: [] });
    w.client.setQueryData(keys.unresolved(WS), { pageParams: [], pages: [] });
    w.engine.start();
    w.open();
    const waiting = w.engine.send({ channelId: CH, content: 'a' });
    const failing = w.engine.send({ channelId: CH, content: 'b' });
    w.deliver(
      frame({ event: 'ERROR', data: { code: 'INTERNAL', message: 'no' }, refId: failing, ts: T0 }),
    );

    expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(false);
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    // The first reconnect comes well inside the three seconds a send is allowed.
    for (let waited = 0; w.sockets.length < 2 && waited < ACK_DEADLINE_MS - 100; waited += 100) {
      w.timers.advance(100);
    }
    expect(w.sockets).toHaveLength(2);
    w.open();

    const sends = w.sentOps('MESSAGE_SEND').map((s) => s.id);
    expect(sends.filter((id) => id === waiting)).toHaveLength(2);
    expect(sends.filter((id) => id === failing)).toHaveLength(1);
    expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.thread('root'))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.unresolved(WS))?.isInvalidated).toBe(true);
    expect(w.engine.store.getState().status).toBe('open');
  });
});

describe('the frames', () => {
  test("a thread update, a reaction set and the caller's own counters reach the rows and the list", () => {
    const w = world();
    const root = echo('0199155c-6200-7b7f-8c11-000000000001', {
      thread: { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
    });
    w.client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [root], nextCursor: null }],
    });
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.engine.start();
    w.open();
    w.deliver(
      frame({
        event: 'THREAD_UPDATED',
        data: { channelId: CH, messageId: root.id, thread: summary },
        ts: T0,
      }),
    );
    w.deliver(
      frame({
        event: 'REACTIONS_UPDATED',
        data: { channelId: CH, messageId: root.id, reactions: [{ emoji: '👍', userIds: [ME.id] }] },
        ts: T0,
      }),
    );
    w.deliver(
      frame({
        event: 'CHANNEL_STATE',
        data: {
          channelId: CH,
          state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 1 },
        },
        ts: T0,
      }),
    );
    w.deliver(frame({ event: 'PONG', data: {}, ts: T0 }));
    const cached = w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0];
    expect(cached?.thread).toEqual(summary);
    expect(cached?.reactions).toEqual([{ emoji: '👍', userIds: [ME.id] }]);
    expect(w.client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.state?.unreadCount).toBe(2);
  });

  test('a channel that appears is added and watched; a revoked one leaves and is let go', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    answerAll(w);
    w.deliver(
      frame({
        event: 'CHANNEL_ADDED',
        data: channel(CH2, { name: null, type: 'direct_message', peer: ME }),
        ts: T0,
      }),
    );
    expect(w.client.getQueryData<Channel[]>(keys.channels(WS))).toHaveLength(2);
    w.timers.advance(2_000);
    const watching = (): string[] =>
      w
        .sentOps('SUBSCRIBE')
        .flatMap((s) => (s.payload['channels'] as { channelId: string }[]).map((c) => c.channelId));
    expect(watching()).toContain(CH2);
    answerAll(w);
    w.deliver(frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2] }, ts: T0 }));
    w.timers.advance(2_000);
    expect(w.client.getQueryData<Channel[]>(keys.channels(WS))?.map((c) => c.id)).toEqual([CH]);
    expect(w.sentOps('UNSUBSCRIBE').flatMap((s) => s.payload['channelIds'] as string[])).toContain(
      CH2,
    );
  });

  test("the end of the session is the screen's to handle", () => {
    const w = world();
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: T0 }));
    expect(w.ended.count).toBe(1);
  });
});

describe('watching channels', () => {
  test('channels asked for before the connection exists are subscribed when it does; later changes are differences', () => {
    const w = world();
    w.engine.watch([CH, CH2]);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    const subscribed = (): string[] =>
      w
        .sentOps('SUBSCRIBE')
        .flatMap((s) => (s.payload['channels'] as { channelId: string }[]).map((c) => c.channelId));
    expect(subscribed().sort()).toEqual([CH, CH2]);
    answerAll(w);
    w.engine.watch([CH]);
    w.timers.advance(2_000);
    expect(w.sentOps('UNSUBSCRIBE').flatMap((s) => s.payload['channelIds'] as string[])).toEqual([
      CH2,
    ]);
    answerAll(w);
    w.engine.watch([CH, CH2]);
    w.timers.advance(2_000);
    expect(subscribed().filter((id) => id === CH2)).toHaveLength(2);
  });

  test('starting twice is one connection; stopping cancels what was waiting', () => {
    const w = world();
    w.engine.start();
    w.engine.start();
    w.open();
    expect(w.sockets).toHaveLength(1);
    w.engine.send({ channelId: CH, content: 'a' });
    w.engine.stop();
    w.timers.advance(ACK_DEADLINE_MS);
    expect(w.pending()[0]?.delivery).toBe('sending');
    expect(w.engine.store.getState().status).toBe('idle');
  });
});

describe('a replay that was one page', () => {
  test('is read on from its cursor until the present, and a failure leaves it for the next reconnect', async () => {
    const asked: (string | undefined)[] = [];
    const w = world({
      messages: (_channel, query) => {
        asked.push(query?.after);
        const first = query?.after === C1;
        return Promise.resolve({
          data: [echo(`0199155c-6200-7b7f-8c11-0000000000${first ? '10' : '11'}`)],
          nextCursor: first ? C2 : null,
        });
      },
    });
    w.client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [], nextCursor: null }],
    });
    w.engine.watch([CH, CH2]);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    answerAll(w, { [CH]: C1 });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(asked).toEqual([C1, C2]);
    expect(w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data).toHaveLength(2);

    const failing = world({
      messages: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    failing.engine.watch([CH]);
    failing.engine.start();
    failing.open();
    failing.timers.advance(2_000);
    answerAll(failing, { [CH]: C1 });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(failing.pending()).toEqual([]);
  });

  test('an unsubscribe acknowledgement is not a send acknowledgement', () => {
    const w = world();
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'ACK', data: { channelIds: [CH] }, ts: T0 }));
    expect(w.pending()).toEqual([]);
  });
});

describe('is the session still there', () => {
  const failures = (w: World): void => {
    w.engine.start();
    for (let i = 0; i < 4; i++) {
      w.sockets.at(-1)?.handlers.closed(1006);
      w.timers.advance(120_000);
    }
  };

  type Me = Api['me'];
  const answers: Me = () =>
    Promise.resolve({ user: { ...ME, email: 'a@example.test' }, memberships: [] });
  const gone: Me = () => Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'));
  const offline: Me = () => Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
  const broken: Me = () => Promise.reject(new Error('boom'));
  const asks: [string, Me, boolean][] = [
    ['answers', answers, false],
    ['says the session is gone', gone, true],
    ['cannot be reached', offline, false],
    ['fails in a way nobody expected', broken, false],
  ];

  test.each(asks)('when the socket keeps failing and the API %s', async (_why, me, ends) => {
    const w = world({ me });
    failures(w);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(w.engine.store.getState().status === 'ended').toBe(ends);
  });
});
