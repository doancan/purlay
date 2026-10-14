/**
 * What a person's own send does between the keystroke and the acknowledgement, and what
 * every frame means to the cache — against a socket and timers driven by hand.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import {
  CLOSE_CODES,
  type Attachment,
  type Channel,
  type MeResponse,
  type Message,
  type MessagePage,
  type ServerFrame,
  TYPING_TTL_MS,
} from '@purlay/types';
import { ApiError } from '../data/errors';
import { keys } from '../data/keys';
import { anApi } from '../testing/fake-api';
import { IDS, aSession, NO_PROFILE } from '../testing/fixtures';
import { fakeSchedule, memoryStorage, type MemoryStorage } from '../testing/fakes';
import type { Api } from '../data/api';
import type { Clock } from './clock';
import type { SocketHandlers } from './connection';
import {
  ACK_DEADLINE_MS,
  REPLAY_RETRY_DELAYS_MS,
  UNNAMED,
  createEngine,
  type Engine,
  type PendingMessage,
} from './engine';
import { MAX_STORED, pendingKey } from './pending-store';

type Pages = InfiniteData<MessagePage, string | undefined>;

const OTHER_CH = '0199155c-6200-7b7f-8c11-0000000000c2';
const T0 = Date.parse('2026-10-09T12:00:00.000Z');
const C1 = '0199155c-6200-7b7f-8c11-0000000000d1';
const C2 = '0199155c-6200-7b7f-8c11-0000000000d2';
const CH = '00000000-0000-4000-8000-0000000000c1';
const CH2 = '00000000-0000-4000-8000-0000000000c2';
const CH3 = '00000000-0000-4000-8000-0000000000c3';
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
  attachments: [],
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
  notificationLevel: 'mentions',
  starred: false,
  peer: null,
  peers: [],
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

interface Extras {
  readonly storage?: MemoryStorage | null;
  readonly userId?: string;
  readonly clock?: Clock;
}

const world = (api: Partial<Api> = {}, extras: Extras = {}): World => {
  const timers = fakeSchedule();
  const sockets: Socket[] = [];
  const client = new QueryClient();
  const ended = { count: 0 };
  const clock: Clock = extras.clock ?? { now: () => new Date(T0) };
  const engine = createEngine({
    api: anApi(api),
    client,
    userId: extras.userId ?? ME.id,
    ...(extras.storage === undefined ? {} : { storage: extras.storage }),
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
        attachments: [],
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
      reason: 'TIMEOUT',
    });

    w.engine.retry(id);
    expect(w.pending()[0]).toMatchObject({ id, delivery: 'sending', reason: null });
    const sends = w.sentOps('MESSAGE_SEND');
    expect(sends.map((s) => s.id)).toEqual([id, id]);
    w.deliver(ack(id));
    w.timers.advance(ACK_DEADLINE_MS * 2);
    expect(w.pending()[0]?.delivery).toBe('sent');
  });

  test("an ERROR that names the send fails it with the server's code; one the connection retries by itself is ignored", () => {
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
    expect(w.pending()[0]).toMatchObject({ delivery: 'failed', reason: 'RATE_LIMITED' });
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

describe('a send carrying attachments (D-109 §7)', () => {
  const SHOT: Attachment = {
    id: '01995f7b-0000-7000-8000-0000000000a1',
    fileName: 'shot.png',
    mimeType: 'image/webp',
    sizeBytes: 900,
    kind: 'image',
    width: 40,
    height: 20,
  };

  test('names them in its frame, and its row carries them before the server answers', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: '', attachments: [SHOT] });
    expect(w.sentOps('MESSAGE_SEND')).toEqual([
      { id, op: 'MESSAGE_SEND', payload: { channelId: CH, content: '', attachmentIds: [SHOT.id] } },
    ]);
    expect(w.pending()[0]?.attachments).toEqual([SHOT]);
  });

  test('over HTTP, the same ids', async () => {
    const sent: unknown[] = [];
    const w = world({
      send: (channelId, input) => {
        sent.push({ channelId, ...input });
        return Promise.resolve(echo(input.id));
      },
    });
    const id = w.engine.send({ channelId: CH, content: 'look', attachments: [SHOT] });
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([{ channelId: CH, id, content: 'look', attachmentIds: [SHOT.id] }]);
  });

  test('a reload keeps them, so Retry sends the same message with the same files', () => {
    const storage = memoryStorage();
    const first = world({}, { storage });
    first.engine.start();
    first.open();
    const id = first.engine.send({ channelId: CH, content: '', attachments: [SHOT] });
    const second = world({}, { storage });
    expect(second.pending()[0]).toMatchObject({ id, content: '', attachments: [SHOT] });
    second.engine.start();
    second.open();
    second.engine.retry(id);
    expect(second.sentOps('MESSAGE_SEND')[0]?.payload).toEqual({
      channelId: CH,
      content: '',
      attachmentIds: [SHOT.id],
    });
  });

  test('what an older page kept, with no attachments, comes back with none', () => {
    const storage = memoryStorage();
    storage.data[pendingKey(ME.id)] = JSON.stringify([
      {
        id: '01995f7b-0000-7000-8000-0000000000b1',
        channelId: CH,
        parentId: null,
        content: 'from before',
        createdAt: '2026-10-09T11:59:00.000Z',
      },
    ]);
    expect(world({}, { storage }).pending()[0]?.attachments).toEqual([]);
  });

  test('kept words-free without anything attached are not trusted, and not brought back', () => {
    const storage = memoryStorage();
    storage.data[pendingKey(ME.id)] = JSON.stringify([
      {
        id: '01995f7b-0000-7000-8000-0000000000b2',
        channelId: CH,
        parentId: null,
        content: '',
        createdAt: '2026-10-09T11:59:00.000Z',
        attachments: [],
      },
    ]);
    expect(world({}, { storage }).pending()).toEqual([]);
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
      reason: 'VALIDATION_FAILED',
    });
    refuse = new Error('boom');
    const second = w.engine.send({ channelId: CH, content: 'y' });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.pending().find((p) => p.id === second)).toMatchObject({
      delivery: 'failed',
      reason: 'UNKNOWN',
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

  test('reads the memberships again: a workspace renamed while the socket was down is not replayed', () => {
    const w = world();
    w.client.setQueryData(keys.me, { stale: false });
    w.engine.start();
    w.open();
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    for (let waited = 0; w.sockets.length < 2 && waited < 10_000; waited += 100) {
      w.timers.advance(100);
    }
    expect(w.client.getQueryState(keys.me)?.isInvalidated).toBe(false);
    w.open();
    expect(w.client.getQueryState(keys.me)?.isInvalidated).toBe(true);
  });
});

describe('a send that failed because the server could not be reached', () => {
  /**
   * The bar promises "messages will send when you are back" (`UX.md` §8). Found against the
   * production stack: during an API crash the HTTP door answered the proxy's 502, the row failed,
   * and nothing sent it when the socket came back. Failing for want of a server is the reconnect's to
   * mend; the id is the client's, so a second attempt is the same message (D-33).
   */
  test('is sent again when the socket is back; a refusal is still left for the person', async () => {
    let reason: Error = new ApiError(0, 'NETWORK', 'down');
    const w = world({ send: () => Promise.reject(reason) });
    w.engine.start();
    w.open();
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    const unreachable = w.engine.send({ channelId: CH, content: 'during the outage' });
    reason = new ApiError(400, 'VALIDATION_FAILED', 'Too long.');
    const refused = w.engine.send({ channelId: CH, content: 'refused' });
    await Promise.resolve();
    await Promise.resolve();
    expect(w.pending().map((p) => [p.id, p.delivery, p.reason])).toEqual([
      [unreachable, 'failed', 'NETWORK'],
      [refused, 'failed', 'VALIDATION_FAILED'],
    ]);

    for (let waited = 0; w.sockets.length < 2 && waited < 60_000; waited += 100) {
      w.timers.advance(100);
    }
    w.open();
    const sends = w.sentOps('MESSAGE_SEND').map((s) => s.id);
    expect(sends).toEqual([unreachable]);
    expect(w.pending().find((p) => p.id === unreachable)).toMatchObject({
      delivery: 'sending',
      reason: null,
    });
    expect(w.pending().find((p) => p.id === refused)).toMatchObject({ delivery: 'failed' });
  });

  test('a send that timed out stays failed for the person on the next connection (§5.3)', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'no answer' });
    w.timers.advance(ACK_DEADLINE_MS);
    expect(w.pending()[0]).toMatchObject({ delivery: 'failed', reason: 'TIMEOUT' });
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    for (let waited = 0; w.sockets.length < 2 && waited < 60_000; waited += 100) {
      w.timers.advance(100);
    }
    w.open();
    expect(w.sentOps('MESSAGE_SEND').filter((s) => s.id === id)).toHaveLength(1);
    expect(w.pending()[0]).toMatchObject({ delivery: 'failed', reason: 'TIMEOUT' });
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
        version: 1,
        ts: T0,
      }),
    );
    w.deliver(
      frame({
        event: 'REACTIONS_UPDATED',
        data: { channelId: CH, messageId: root.id, reactions: [{ emoji: '👍', userIds: [ME.id] }] },
        version: 1,
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
        version: 1,
        ts: T0,
      }),
    );
    w.deliver(frame({ event: 'PONG', data: {}, ts: T0 }));
    const cached = w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0];
    expect(cached?.thread).toEqual(summary);
    expect(cached?.reactions).toEqual([{ emoji: '👍', userIds: [ME.id] }]);
    expect(w.client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.state?.unreadCount).toBe(2);
  });

  /**
   * Whole-state frames are published after their commits and from different requests, so a
   * late one can arrive behind a newer one (0015). Replacing the newer state with it would
   * stick until something else moved the row, so each carries the order it was written in.
   */
  describe('a whole state that arrives late', () => {
    const counters = (unreadCount: number, version: number): ServerFrame =>
      frame({
        event: 'CHANNEL_STATE',
        data: {
          channelId: CH,
          state: { lastReadMessageId: null, unreadCount, unreadMentionCount: 0 },
        },
        version,
        ts: T0,
      });
    const unread = (w: ReturnType<typeof world>): number | undefined =>
      w.client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.state?.unreadCount;

    test('does not replace a newer one, is applied again when told twice, and is per channel', () => {
      const w = world();
      w.client.setQueryData(keys.channels(WS), [channel(CH), channel(OTHER_CH)]);
      w.engine.start();
      w.open();

      w.deliver(counters(5, 7));
      w.deliver(counters(4, 6)); // committed before the one above, published after it
      expect(unread(w)).toBe(5);

      w.deliver(counters(0, 7)); // the same version again: a re-told state, applied
      expect(unread(w)).toBe(0);
      w.deliver(counters(9, 8));
      expect(unread(w)).toBe(9);

      // Another channel's counter is another thing: its first frame is its own newest.
      w.deliver(
        frame({
          event: 'CHANNEL_STATE',
          data: {
            channelId: OTHER_CH,
            state: { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 0 },
          },
          version: 1,
          ts: T0,
        }),
      );
      const other = w.client.getQueryData<Channel[]>(keys.channels(WS))?.[1];
      expect(other?.state?.unreadCount).toBe(3);
    });

    test('a channel’s new name and topic replace what the list holds, and a late rename does not undo a newer one (D-123)', () => {
      const w = world();
      w.client.setQueryData(keys.channels(WS), [channel(CH)]);
      w.engine.start();
      w.open();
      const renamed = (name: string, version: number): ServerFrame =>
        frame({
          event: 'CHANNEL_UPDATED',
          data: { channelId: CH, name, topic: `about ${name}` },
          version,
          ts: T0,
        });
      const held = (): Channel | undefined =>
        w.client.getQueryData<Channel[]>(keys.channels(WS))?.[0];

      w.deliver(renamed('genel-sohbet', 2));
      expect(held()).toMatchObject({ name: 'genel-sohbet', topic: 'about genel-sohbet' });
      w.deliver(renamed('general', 1)); // committed first, arrived last
      expect(held()?.name).toBe('genel-sohbet');
      w.deliver(renamed('lobby', 3));
      expect(held()?.name).toBe('lobby');
    });

    test('a thread summary and a reaction set are ordered separately, though they share a counter', () => {
      const w = world();
      const root = echo('0199155c-6200-7b7f-8c11-000000000001');
      w.client.setQueryData<Pages>(keys.messages(CH), {
        pageParams: [undefined],
        pages: [{ data: [root], nextCursor: null }],
      });
      w.engine.start();
      w.open();
      const reactions = (emoji: string, version: number): ServerFrame =>
        frame({
          event: 'REACTIONS_UPDATED',
          data: { channelId: CH, messageId: root.id, reactions: [{ emoji, userIds: [ME.id] }] },
          version,
          ts: T0,
        });
      const thread = (replyCount: number, version: number): ServerFrame =>
        frame({
          event: 'THREAD_UPDATED',
          data: { channelId: CH, messageId: root.id, thread: { ...summary, replyCount } },
          version,
          ts: T0,
        });
      const row = (): Message | undefined =>
        w.client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0];

      w.deliver(reactions('🎉', 3));
      w.deliver(thread(2, 2)); // older than the reaction's version, but a different kind: applied
      expect(row()?.thread?.replyCount).toBe(2);
      w.deliver(thread(1, 1)); // older than the summary held: dropped
      expect(row()?.thread?.replyCount).toBe(2);
      w.deliver(reactions('👍', 2)); // older than the set held: dropped
      expect(row()?.reactions).toEqual([{ emoji: '🎉', userIds: [ME.id] }]);
    });
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
    // Let go without a frame (the server dropped it as it said so, #523), and not asked for again.
    expect(w.sentOps('UNSUBSCRIBE')).toEqual([]);
    const before = watching().filter((id) => id === CH2).length;
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    for (let waited = 0; w.sockets.length < 2 && waited < 10_000; waited += 100) {
      w.timers.advance(100);
    }
    w.open();
    w.timers.advance(2_000);
    expect(watching().filter((id) => id === CH2)).toHaveLength(before);
  });

  test('a channel archived, or left on another screen, is remembered with why; a removal says nothing (D-123)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH), channel(CH2)]);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH] }, ts: T0 }));
    expect(w.engine.store.getState().gone).toEqual({});
    w.deliver(
      frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2], reason: 'archived' }, ts: T0 }),
    );
    expect(w.engine.store.getState().gone).toEqual({ [CH2]: 'archived' });
    // Left: a public channel is still there to be seen, so the list is asked for again.
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.deliver(
      frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH], reason: 'left' }, ts: T0 }),
    );
    expect(w.engine.store.getState().gone).toEqual({ [CH]: 'left', [CH2]: 'archived' });
    expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
  });

  test('a channel given back forgets why it went: a later removal does not read as the old reason (D-123)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.engine.start();
    w.open();
    w.deliver(
      frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2], reason: 'left' }, ts: T0 }),
    );
    expect(w.engine.store.getState().gone).toEqual({ [CH2]: 'left' });
    w.deliver(frame({ event: 'CHANNEL_ADDED', data: channel(CH2), ts: T0 }));
    expect(w.engine.store.getState().gone).toEqual({});
    w.deliver(frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2] }, ts: T0 }));
    expect(w.engine.store.getState().gone).toEqual({});
  });

  test('channels taken away are let go without a frame: the server already dropped them (#523)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH), channel(CH2), channel(CH3)]);
    w.engine.watch([CH, CH2, CH3]);
    w.engine.start();
    w.open();
    w.deliver(
      frame({
        event: 'ACCESS_REVOKED',
        data: { channelIds: [CH, CH2, CH3], reason: 'archived' },
        ts: T0,
      }),
    );
    expect(w.sentOps('UNSUBSCRIBE')).toEqual([]);
  });

  test('channels leaving the watched set together go in one UNSUBSCRIBE (#523)', () => {
    const w = world();
    w.engine.watch([CH, CH2, CH3]);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    answerAll(w);
    w.engine.watch([]);
    const sent = w.sentOps('UNSUBSCRIBE');
    expect(sent).toHaveLength(1);
    expect(new Set(sent[0]?.payload['channelIds'] as string[])).toEqual(new Set([CH, CH2, CH3]));
  });

  test('a channel taken away takes its unsent messages with it, from the store and from storage, and says how many (#521)', () => {
    const storage = memoryStorage();
    const w = world({}, { storage });
    w.client.setQueryData(keys.channels(WS), [channel(CH), channel(CH2)]);
    w.engine.watch([CH, CH2]);
    w.engine.start();
    w.open();
    w.engine.send({ channelId: CH2, content: 'on its way' });
    const failing = w.engine.send({ channelId: CH2, content: 'refused' });
    const elsewhere = w.engine.send({ channelId: CH, content: 'stays' });
    w.deliver(
      frame({ event: 'ERROR', data: { code: 'INTERNAL', message: 'no' }, refId: failing, ts: T0 }),
    );
    expect(w.engine.store.getState().lost).toBeNull();

    w.deliver(
      frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2], reason: 'archived' }, ts: T0 }),
    );

    expect(w.pending().map((p) => p.id)).toEqual([elsewhere]);
    expect(w.engine.store.getState().lost).toEqual({ count: 2, seq: 1 });
    // A reload brings back only what is still somebody's to send.
    expect(
      world({}, { storage })
        .pending()
        .map((p) => p.id),
    ).toEqual([elsewhere]);
  });

  test('a send the server answers with the channel gone goes, and is counted, rather than waiting failed for ever (#521)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH)]);
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'into nothing' });
    w.deliver(
      frame({
        event: 'ERROR',
        data: { code: 'CHANNEL_NOT_FOUND', message: 'gone' },
        refId: id,
        ts: T0,
      }),
    );
    expect(w.pending()).toEqual([]);
    expect(w.engine.store.getState().lost).toEqual({ count: 1, seq: 1 });
  });

  test('a subscription refused for good takes the channel’s unsent messages too (#521)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH), channel(CH2)]);
    w.engine.watch([CH, CH2]);
    w.engine.start();
    w.open();
    w.engine.send({ channelId: CH2, content: 'waiting' });
    w.timers.advance(2_000);
    const subscribe = w.sentOps('SUBSCRIBE').at(-1);
    w.deliver(
      frame({
        event: 'ERROR',
        data: { code: 'CHANNEL_NOT_FOUND', message: 'gone' },
        refId: subscribe?.id ?? '',
        ts: T0,
      }),
    );
    expect(w.pending().filter((p) => p.channelId === CH2)).toEqual([]);
    expect(w.engine.store.getState().lost?.count).toBe(1);
  });

  test('channels lost while nobody was told — dropped from the list — take their unsent messages (#521)', () => {
    const w = world();
    w.engine.start();
    w.open();
    w.engine.send({ channelId: CH2, content: 'waiting' });
    w.engine.lose([CH2]);
    expect(w.pending()).toEqual([]);
    expect(w.engine.store.getState().lost?.count).toBe(1);
  });

  test('a channel taken away with nothing unsent says nothing (#521)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), [channel(CH), channel(CH2)]);
    w.engine.watch([CH, CH2]);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH2] }, ts: T0 }));
    expect(w.engine.store.getState().lost).toBeNull();
  });

  test("the end of the session is the screen's to handle", () => {
    const w = world();
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'SESSION_ENDED', data: { reason: 'signed-out' }, ts: T0 }));
    expect(w.ended.count).toBe(1);
  });

  test('a workspace that changed has the memberships read again, not patched from the frame', () => {
    const w = world();
    w.client.setQueryData(keys.me, { stale: false });
    w.engine.start();
    w.open();
    expect(w.client.getQueryState(keys.me)?.isInvalidated).toBe(false);
    w.deliver(frame({ event: 'WORKSPACE_UPDATED', data: { workspaceId: WS }, ts: T0 }));
    expect(w.client.getQueryState(keys.me)?.isInvalidated).toBe(true);
  });

  test('back from a gap, every workspace’s members are read again: a profile may have changed (D-131)', () => {
    const w = world();
    w.client.setQueryData(keys.members(WS), []);
    w.engine.start();
    w.open();
    expect(w.client.getQueryState(keys.members(WS))?.isInvalidated).toBe(false);
    w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
    for (let waited = 0; w.sockets.length < 2 && waited < 10_000; waited += 100) {
      w.timers.advance(100);
    }
    w.open();
    expect(w.client.getQueryState(keys.members(WS))?.isInvalidated).toBe(true);
  });

  test('and its members, whose profiles it may be saying changed — that workspace’s only (D-131)', () => {
    const w = world();
    w.client.setQueryData(keys.members(WS), []);
    w.client.setQueryData(keys.members(IDS.browse), []);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'WORKSPACE_UPDATED', data: { workspaceId: WS }, ts: T0 }));
    expect(w.client.getQueryState(keys.members(WS))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.members(IDS.browse))?.isInvalidated).toBe(false);
  });
});

describe('Deep Work changed in another tab (#526)', () => {
  test('is drawn here: the membership says until when, and an end clears it', () => {
    const w = world();
    const other = {
      ...aSession().memberships[0]!,
      workspace: { ...aSession().memberships[0]!.workspace, id: IDS.browse },
    };
    w.client.setQueryData(keys.me, {
      ...aSession(),
      memberships: [...aSession().memberships, other],
    });
    w.engine.start();
    w.open();
    const until = '2026-09-09T13:00:00.000Z';
    w.deliver(frame({ event: 'DEEP_WORK_UPDATED', data: { workspaceId: WS, until }, ts: T0 }));
    const me = (): MeResponse | undefined => w.client.getQueryData<MeResponse>(keys.me);
    expect(me()?.memberships.find((m) => m.workspace.id === WS)?.deepWorkUntil).toBe(until);
    // Another workspace's Deep Work is its own.
    expect(me()?.memberships.find((m) => m.workspace.id === IDS.browse)?.deepWorkUntil).toBeNull();
    w.deliver(
      frame({ event: 'DEEP_WORK_UPDATED', data: { workspaceId: WS, until: null }, ts: T0 }),
    );
    expect(me()?.memberships.find((m) => m.workspace.id === WS)?.deepWorkUntil).toBeNull();
  });

  test('a channel list changed elsewhere is read again, in that workspace only (D-132)', () => {
    const w = world();
    w.client.setQueryData(keys.channels(WS), []);
    w.client.setQueryData(keys.channels(IDS.browse), []);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'CHANNELS_UPDATED', data: { workspaceId: WS }, ts: T0 }));
    expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.channels(IDS.browse))?.isInvalidated).toBe(false);
  });

  test('saved messages changed elsewhere are read again, in that workspace only (D-128)', () => {
    const w = world();
    w.client.setQueryData([...keys.saved(WS), 'ids'], []);
    w.client.setQueryData([...keys.saved(IDS.browse), 'ids'], []);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'SAVED_UPDATED', data: { workspaceId: WS }, ts: T0 }));
    const stale = (workspaceId: string): boolean | undefined =>
      w.client.getQueryState([...keys.saved(workspaceId), 'ids'])?.isInvalidated;
    expect(stale(WS)).toBe(true);
    expect(stale(IDS.browse)).toBe(false);
  });

  test('a channel’s pins changed are read again, in that channel only (D-130)', () => {
    const w = world();
    w.client.setQueryData(keys.pins(CH), []);
    w.client.setQueryData(keys.pins(CH2), []);
    w.engine.start();
    w.open();
    w.deliver(frame({ event: 'PINS_UPDATED', data: { channelId: CH }, ts: T0 }));
    expect(w.client.getQueryState(keys.pins(CH))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.pins(CH2))?.isInvalidated).toBe(false);
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
    Promise.resolve({
      user: { ...ME, email: 'a@example.test' },
      profile: NO_PROFILE,
      memberships: [],
    });
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

/**
 * What the server refuses, and what cannot be finished, is said — never swallowed (review:
 * a refused SUBSCRIBE left those channels without live updates and nothing on screen said so).
 */
describe('a subscription the server refuses', () => {
  const subscribeId = (w: World): string => {
    const sent = w.sentOps('SUBSCRIBE').at(-1);
    if (sent === undefined) throw new Error('nothing subscribed');
    return sent.id;
  };
  const opened = (channels: string[]): World => {
    const w = world();
    w.client.setQueryData(
      keys.channels(WS),
      channels.map((id) => channel(id)),
    );
    w.engine.watch(channels);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    return w;
  };
  const refuse = (
    w: World,
    code: 'CHANNEL_NOT_FOUND' | 'FORBIDDEN' | 'UNSUPPORTED_MEDIA_TYPE' | 'INTERNAL',
  ): void => {
    w.deliver({
      event: 'ERROR',
      data: { code, message: 'no' },
      refId: subscribeId(w),
      ts: T0,
    });
  };

  test('for a reason waiting will not change leaves the channels degraded, with the code, for the bar to show', () => {
    const w = opened([CH, CH2]);
    refuse(w, 'UNSUPPORTED_MEDIA_TYPE');
    expect(w.engine.store.getState().degraded).toEqual({
      [CH]: 'UNSUPPORTED_MEDIA_TYPE',
      [CH2]: 'UNSUPPORTED_MEDIA_TYPE',
    });
  });

  test.each(['CHANNEL_NOT_FOUND', 'FORBIDDEN'] as const)(
    'with %s lets the channels go and asks for the list again: live updates it will never have are not a state to show',
    (code) => {
      const w = opened([CH, CH2]);
      refuse(w, code);
      expect(w.engine.store.getState().degraded).toEqual({});
      expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
      // Let go: a reconnect does not ask for them again.
      w.sockets.at(-1)?.handlers.closed(CLOSE_CODES.RESTARTING);
      for (let waited = 0; w.sockets.length < 2 && waited < 3_000; waited += 100)
        w.timers.advance(100);
      w.open();
      w.timers.advance(2_000);
      const asked = w
        .sentOps('SUBSCRIBE')
        .slice(1)
        .flatMap((s) => s.payload['channels'] as { channelId: string }[]);
      expect(asked).toEqual([]);
    },
  );

  test("is reported once: the ERROR that follows the connection's report is not a second, unnamed failure", () => {
    const w = opened([CH]);
    refuse(w, 'INTERNAL');
    expect(Object.keys(w.engine.store.getState().degraded)).toEqual([CH]);
  });

  test('Retry asks again for exactly those channels, and clears what was said', () => {
    const w = opened([CH, CH2]);
    refuse(w, 'INTERNAL');
    const before = w.sentOps('SUBSCRIBE').length;
    w.engine.retryDegraded();
    expect(w.engine.store.getState().degraded).toEqual({});
    w.timers.advance(2_000);
    answerAll(w);
    w.timers.advance(2_000);
    expect(w.sentOps('SUBSCRIBE').length).toBeGreaterThan(before);
    expect(w.client.getQueryState(keys.channels(WS))?.isInvalidated).toBe(true);
  });
});

describe('an error that answers nothing the client can name', () => {
  test('is shown as degraded under the unnamed key, and not for what the connection retries by itself', () => {
    const w = world();
    w.engine.start();
    w.open();
    w.deliver({ event: 'ERROR', data: { code: 'RATE_LIMITED', message: 'x' }, ts: T0 });
    w.deliver({
      event: 'ERROR',
      data: { code: 'DATABASE_UNAVAILABLE', message: 'x' },
      refId: '0199155c-6200-7b7f-8c11-0000000000aa',
      ts: T0,
    });
    expect(w.engine.store.getState().degraded).toEqual({});
    w.deliver({ event: 'ERROR', data: { code: 'INTERNAL', message: 'x' }, ts: T0 });
    expect(w.engine.store.getState().degraded).toEqual({ [UNNAMED]: 'INTERNAL' });
    w.engine.retryDegraded();
    expect(w.engine.store.getState().degraded).toEqual({});
  });
});

describe('a replay that cannot be finished', () => {
  const failingThenOk = (failures: number): { api: Partial<Api>; asked: () => number } => {
    let asks = 0;
    return {
      asked: () => asks,
      api: {
        messages: (): Promise<MessagePage> => {
          asks += 1;
          return asks <= failures
            ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
            : Promise.resolve({ data: [], nextCursor: null });
        },
      },
    };
  };
  const startReplay = async (api: Partial<Api>): Promise<World> => {
    const w = world(api);
    w.client.setQueryData<Pages>(keys.messages(CH), {
      pageParams: [undefined],
      pages: [{ data: [], nextCursor: null }],
    });
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    w.timers.advance(2_000);
    answerAll(w, { [CH]: C1 });
    for (let i = 0; i < 6; i++) await Promise.resolve();
    return w;
  };

  test('is tried again after waits that grow, and succeeds without ever saying anything', async () => {
    const { api, asked } = failingThenOk(2);
    const w = await startReplay(api);
    expect(asked()).toBe(1);
    w.timers.advance(REPLAY_RETRY_DELAYS_MS[0] ?? 0);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(asked()).toBe(2);
    w.timers.advance(REPLAY_RETRY_DELAYS_MS[1] ?? 0);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(asked()).toBe(3);
    expect(w.engine.store.getState().degraded).toEqual({});
  });

  test('that never works hands the channel back to the server whole, and says the channel is degraded', async () => {
    const { api, asked } = failingThenOk(99);
    const w = await startReplay(api);
    for (const wait of REPLAY_RETRY_DELAYS_MS) {
      w.timers.advance(wait);
      for (let i = 0; i < 6; i++) await Promise.resolve();
    }
    expect(asked()).toBe(REPLAY_RETRY_DELAYS_MS.length + 1);
    expect(w.engine.store.getState().degraded).toEqual({ [CH]: 'REPLAY' });
    expect(w.client.getQueryState(keys.messages(CH))?.isInvalidated).toBe(true);
  });

  test('a second acknowledgement for the same channel does not start a parallel read', async () => {
    let release: () => void = () => undefined;
    let asks = 0;
    const w = await startReplay({
      messages: () => {
        asks += 1;
        return new Promise((resolve) => {
          release = (): void => {
            resolve({ data: [], nextCursor: null });
          };
        });
      },
    });
    w.deliver({ event: 'ACK', data: { channels: [{ channelId: CH, nextCursor: C1 }] }, ts: T0 });
    expect(asks).toBe(1);
    release();
  });

  test('stopping ends one that is waiting between attempts: it does not wake into a dead engine', async () => {
    const { api, asked } = failingThenOk(99);
    const w = await startReplay(api);
    w.engine.stop();
    w.timers.advance(60_000);
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(asked()).toBe(1);
    expect(w.engine.store.getState().degraded).toEqual({});
  });

  test('stopping while a page is in flight ends the continuation without releasing the channel', async () => {
    let release: () => void = () => undefined;
    const w = await startReplay({
      messages: () =>
        new Promise((resolve) => {
          release = (): void => {
            resolve({ data: [], nextCursor: null });
          };
        }),
    });
    w.engine.stop();
    release();
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(w.engine.store.getState().degraded).toEqual({});
  });

  test('a failure after the page stopped says nothing', async () => {
    let fail: (reason: Error) => void = () => undefined;
    const w = await startReplay({
      messages: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    w.engine.stop();
    fail(new ApiError(0, 'NETWORK', 'offline'));
    for (let i = 0; i < 6; i++) await Promise.resolve();
    expect(w.engine.store.getState().degraded).toEqual({});
  });
});

describe('what was in flight when the page went', () => {
  const key = pendingKey(ME.id);

  test('is kept as it is sent, and not once the server has it', () => {
    const storage = memoryStorage();
    const w = world({}, { storage });
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'hello', parentId: 'root-9' });
    expect(JSON.parse(storage.data[key] ?? '[]')).toEqual([
      {
        id,
        channelId: CH,
        parentId: 'root-9',
        content: 'hello',
        createdAt: '2026-10-09T12:00:00.000Z',
        attachments: [],
      },
    ]);
    w.deliver(ack(id));
    expect(storage.data[key]).toBeUndefined();
  });

  test('comes back after a reload as failed, with the same id, and Retry sends exactly that', () => {
    const storage = memoryStorage();
    const first = world({}, { storage });
    first.engine.start();
    first.open();
    const id = first.engine.send({ channelId: CH, content: 'typed just before the tab died' });

    const second = world({}, { storage });
    expect(second.pending()).toEqual([
      {
        id,
        channelId: CH,
        parentId: null,
        content: 'typed just before the tab died',
        createdAt: '2026-10-09T12:00:00.000Z',
        delivery: 'failed',
        reason: null,
        attachments: [],
      },
    ]);
    second.engine.start();
    second.open();
    second.engine.retry(id);
    expect(second.sentOps('MESSAGE_SEND').map((f) => f.id)).toEqual([id]);
    second.deliver({ event: 'MESSAGE_CREATED', data: echo(id), version: 1, ts: T0 } as ServerFrame);
    expect(second.pending()).toEqual([]);
    expect(storage.data[key]).toBeUndefined();
  });

  test('is never shown to, or re-sent by, a different person on the same browser', () => {
    const storage = memoryStorage();
    const mine = world({}, { storage });
    mine.engine.start();
    mine.open();
    mine.engine.send({ channelId: CH, content: 'mine' });
    const theirs = world({}, { storage, userId: '00000000-0000-4000-8000-0000000000f9' });
    expect(theirs.pending()).toEqual([]);
  });

  test('is kept within bounds: the newest fifty, and no more characters than the quota can spare', () => {
    const storage = memoryStorage();
    const w = world({}, { storage });
    w.engine.start();
    w.open();
    for (let i = 0; i < MAX_STORED + 5; i++)
      w.engine.send({ channelId: CH, content: `m${String(i)}` });
    expect((JSON.parse(storage.data[key] ?? '[]') as unknown[]).length).toBe(MAX_STORED);
    expect(w.pending()).toHaveLength(MAX_STORED + 5);
  });

  test('survives storage that is missing, full or refuses: the send works, only the memory does not', () => {
    const throwing = {
      ...memoryStorage(),
      setItem: (): void => {
        throw new Error('quota');
      },
      getItem: (): string => {
        throw new Error('blocked');
      },
    } as unknown as MemoryStorage;
    const w = world({}, { storage: throwing });
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'still sends' });
    expect(w.sentOps('MESSAGE_SEND').map((f) => f.id)).toEqual([id]);
    const none = world({}, { storage: null });
    none.engine.start();
    none.open();
    none.engine.send({ channelId: CH, content: 'no storage at all' });
    expect(none.pending()).toHaveLength(1);
  });

  test('a page that stopped and started again (StrictMode) owes its waiting sends a re-send on the next open', () => {
    const w = world();
    w.engine.start();
    w.open();
    const id = w.engine.send({ channelId: CH, content: 'in flight' });
    w.engine.stop();
    w.timers.advance(ACK_DEADLINE_MS * 2);
    expect(w.pending()[0]?.delivery).toBe('sending'); // the deadline timer went with the stop
    w.engine.start();
    w.open();
    expect(w.sentOps('MESSAGE_SEND').filter((f) => f.id === id)).toHaveLength(2);
    w.timers.advance(ACK_DEADLINE_MS);
    expect(w.pending()[0]?.delivery).toBe('failed'); // and the deadline is armed again
  });
});

describe('what happened between a list being read and the channel being subscribed', () => {
  test('a feed or thread read before the subscription was answered is read again: reactions and resolutions are not replayed, so what it holds may already be stale', () => {
    const ROOT = '0199155c-6200-7b7f-8c11-000000000001';
    const w = world();
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    // The feed and a thread were fetched; then the subscription's answer arrives.
    w.client.setQueryData(keys.messages(CH), { pages: [], pageParams: [] });
    w.client.setQueryData(keys.thread(ROOT), { pages: [], pageParams: [] });
    w.client.setQueryData(keys.messages(OTHER_CH), { pages: [], pageParams: [] });
    answerAll(w);
    expect(w.client.getQueryState(keys.messages(CH))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.thread(ROOT))?.isInvalidated).toBe(true);
    // A channel that was not part of the answer is left as it was.
    expect(w.client.getQueryState(keys.messages(OTHER_CH))?.isInvalidated).toBe(false);
  });

  test('a channel’s files read before the subscription was answered are read again (D-129)', () => {
    const w = world();
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    w.client.setQueryData(keys.files(CH), { pages: [], pageParams: [] });
    w.client.setQueryData(keys.files(OTHER_CH), { pages: [], pageParams: [] });
    w.client.setQueryData(keys.pins(CH), []);
    answerAll(w);
    expect(w.client.getQueryState(keys.files(CH))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.pins(CH))?.isInvalidated).toBe(true);
    expect(w.client.getQueryState(keys.files(OTHER_CH))?.isInvalidated).toBe(false);
  });

  /**
   * #347: a read already on its way when the answer came is left to finish — cancelling it stalls
   * the screen driving it — but what it brings back may predate the subscription, so it is read
   * again once it has finished. Without this, a reply that landed in that gap was never shown.
   */
  test('a feed being read when the subscription is answered is read again once that read is done', async () => {
    const w = world();
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    let finish = (): void => undefined;
    const reading = w.client.query({
      queryKey: keys.messages(CH),
      queryFn: () =>
        new Promise<Pages>((resolve) => {
          finish = (): void => {
            resolve({ pages: [], pageParams: [] });
          };
        }),
    });
    answerAll(w);
    expect(w.client.getQueryState(keys.messages(CH))?.fetchStatus).toBe('fetching');
    finish();
    await reading;
    await Promise.resolve();
    expect(w.client.getQueryState(keys.messages(CH))?.isInvalidated).toBe(true);
  });

  test('a read that is thrown away before it finishes leaves nothing waiting on it', async () => {
    const w = world();
    w.engine.watch([CH]);
    w.engine.start();
    w.open();
    const reading = w.client
      .query({
        queryKey: keys.messages(CH),
        queryFn: () => new Promise<Pages>(() => undefined),
      })
      .then(
        () => 'read',
        () => 'thrown away',
      );
    answerAll(w);
    w.client.removeQueries({ queryKey: keys.messages(CH) });
    await Promise.resolve();
    expect(w.client.getQueryState(keys.messages(CH))).toBeUndefined();
    // Read afresh, the channel is not marked by the answer that came before it existed.
    w.client.setQueryData(keys.messages(CH), { pages: [], pageParams: [] });
    expect(w.client.getQueryState(keys.messages(CH))?.isInvalidated).toBe(false);
    expect(await reading).toBe('thrown away');
  });
});

/**
 * Who is typing (#411): ephemeral, so the client forgets on its own — when the announcement runs
 * out, or when the person's message arrives — and never shows a person themselves.
 */
describe('typing', () => {
  const ANA = '00000000-0000-4000-8000-0000000000f1';
  const BEN = '00000000-0000-4000-8000-0000000000f2';
  const typing = (userId: string, channelId = CH, ttlMs = 6_000): ServerFrame => ({
    event: 'TYPING',
    data: { channelId, userId, ttlMs },
    ts: T0,
  });
  const typists = (w: World, channelId = CH): readonly string[] | undefined =>
    w.engine.store.getState().typing[channelId];
  const started = (): World => {
    const w = world();
    w.engine.start();
    w.open();
    return w;
  };

  test('names who is typing in which channel, in the order they began', () => {
    const w = started();
    w.deliver(typing(BEN));
    w.deliver(typing(ANA));
    w.deliver(typing(ANA, CH2));
    expect(typists(w)).toEqual([BEN, ANA]);
    expect(typists(w, CH2)).toEqual([ANA]);
  });

  test('forgets a person whose announcement ran out, and keeps one who announced again', () => {
    const w = started();
    w.deliver(typing(ANA, CH, 6_000));
    w.deliver(typing(BEN, CH, 6_000));
    w.timers.advance(3_000);
    w.deliver(typing(BEN, CH, 6_000));
    w.timers.advance(2_999);
    expect(typists(w)).toEqual([ANA, BEN]);
    w.timers.advance(1);
    expect(typists(w)).toEqual([BEN]);
    w.timers.advance(3_000);
    // Nobody left: the channel is not kept as an empty list.
    expect(typists(w)).toBeUndefined();
  });

  test("a person's message ends their typing at once, in that channel only", () => {
    const w = started();
    w.deliver(typing(ANA));
    w.deliver(typing(ANA, CH2));
    w.deliver(
      frame({
        event: 'MESSAGE_CREATED',
        data: echo('0199155c-6200-7b7f-8c11-0000000000a9', {
          sender: { ...ME, id: ANA, username: 'ana' },
        }),
        ts: T0,
      }),
    );
    expect(typists(w)).toBeUndefined();
    expect(typists(w, CH2)).toEqual([ANA]);
    // The timer that would have ended it is gone too, so nothing fires into a later announcement.
    w.deliver(typing(ANA));
    w.timers.advance(5_999);
    expect(typists(w)).toEqual([ANA]);
  });

  test('never shows the person themselves, typing in another tab', () => {
    const w = started();
    w.deliver(typing(ME.id));
    expect(typists(w)).toBeUndefined();
  });

  test('a channel taken away takes its typists with it', () => {
    const w = started();
    w.deliver(typing(ANA));
    w.deliver(typing(BEN, CH2));
    w.deliver(frame({ event: 'ACCESS_REVOKED', data: { channelIds: [CH] }, ts: T0 }));
    expect(typists(w)).toBeUndefined();
    expect(typists(w, CH2)).toEqual([BEN]);
  });

  test('a stopped engine shows nobody typing and leaves no timer behind', () => {
    const w = started();
    w.deliver(typing(ANA));
    w.engine.stop();
    expect(w.engine.store.getState().typing).toEqual({});
    expect(w.timers.pending()).toBe(0);
  });
});

/**
 * Saying that the person is typing (#411): over an open socket only, rationed as the server
 * rations it, and news again once their message is sent.
 */
describe('announcing typing', () => {
  const started = (now: { at: number }): World => {
    const w = world({}, { clock: { now: () => new Date(now.at) } });
    w.engine.start();
    w.open();
    return w;
  };

  test('goes out once per half window per channel, naming the channel', () => {
    const now = { at: T0 };
    const w = started(now);
    w.engine.announceTyping(CH);
    w.engine.announceTyping(CH);
    w.engine.announceTyping(CH2);
    now.at += TYPING_TTL_MS / 2 - 1;
    w.engine.announceTyping(CH);
    expect(w.sentOps('TYPING').map((f) => f.payload)).toEqual([
      { channelId: CH },
      { channelId: CH2 },
    ]);
    now.at += 1;
    w.engine.announceTyping(CH);
    expect(w.sentOps('TYPING')).toHaveLength(3);
  });

  test('says nothing while the socket is not open: it is not worth an HTTP request', () => {
    const w = world();
    w.engine.start();
    w.engine.announceTyping(CH);
    expect(w.sentOps('TYPING')).toEqual([]);
  });

  test('a sent message makes the next keystroke news at once', () => {
    const now = { at: T0 };
    const w = started(now);
    w.engine.announceTyping(CH);
    w.engine.send({ channelId: CH, content: 'hello' });
    w.engine.announceTyping(CH);
    expect(w.sentOps('TYPING')).toHaveLength(2);
  });

  test('an announcement refused is not a broken channel', () => {
    const w = started({ at: T0 });
    w.engine.announceTyping(CH);
    const [sent] = w.sentOps('TYPING');
    if (sent === undefined) throw new Error('nothing was announced');
    w.deliver({
      event: 'ERROR',
      data: { code: 'CHANNEL_NOT_FOUND', message: 'That channel does not exist.' },
      refId: sent.id,
      ts: T0,
    });
    expect(w.engine.store.getState().degraded).toEqual({});
  });
});
