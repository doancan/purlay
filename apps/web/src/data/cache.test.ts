/**
 * The cache's one way of learning, driven by hand: frames and answers go in, the
 * lists the screens read come out. No React, no network.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { Channel, Message, MessagePage } from '@purlay/types';
import {
  channelAdded,
  channelsRevoked,
  channelStateChanged,
  messageCreated,
  newestMessageId,
  patchMessage,
  reactionsUpdated,
  threadUpdated,
} from './cache';
import { keys } from './keys';

type Pages = InfiniteData<MessagePage, string | undefined>;

const WS = '00000000-0000-4000-8000-0000000000a1';
const CH = '00000000-0000-4000-8000-0000000000c1';
const user = {
  id: '00000000-0000-4000-8000-0000000000e1',
  username: 'alice',
  displayName: 'Alice',
  avatarUrl: null,
};
const empty = { replyCount: 0, lastReplyAt: null, resolvedAt: null, resolvedBy: null };

const id = (n: number): string => `0199155c-6200-7b7f-8c11-${String(n).padStart(12, '0')}`;
const message = (n: number, over: Partial<Message> = {}): Message => ({
  id: id(n),
  channelId: CH,
  sender: user,
  content: `m${String(n)}`,
  editedAt: null,
  deletedAt: null,
  createdAt: `2026-09-09T08:00:0${String(n)}.000Z`,
  parentId: null,
  thread: empty,
  reactions: [],
  mentions: [],
  ...over,
});
const state = { lastReadMessageId: null, unreadCount: 0, unreadMentionCount: 0 };
const channel = (over: Partial<Channel> = {}): Channel => ({
  id: CH,
  workspaceId: WS,
  name: 'api',
  topic: null,
  type: 'public',
  lastMessageAt: null,
  state,
  peer: null,
  ...over,
});
const pages = (...lists: Message[][]): Pages => ({
  pageParams: lists.map(() => undefined),
  pages: lists.map((data) => ({ data, nextCursor: null })),
});

const seeded = (): QueryClient => {
  const client = new QueryClient();
  client.setQueryData(keys.messages(CH), pages([message(3), message(2)], [message(1)]));
  client.setQueryData(keys.channels(WS), [channel()]);
  return client;
};
/** What the cache holds under a key, as `unknown` — the typed overloads infer `void` from a bare key. */
const cached = (client: QueryClient, key: readonly unknown[]): unknown => client.getQueryData(key);
const feed = (client: QueryClient): string[] =>
  (client.getQueryData<Pages>(keys.messages(CH))?.pages ?? []).flatMap((p) =>
    p.data.map((m) => m.id),
  );

describe('a message arrives', () => {
  test('a root joins the head of its feed in id order, once, however it arrives', () => {
    const client = seeded();
    messageCreated(client, message(5));
    messageCreated(client, message(4));
    messageCreated(client, message(5)); // the replay of what the socket already said
    expect(feed(client)).toEqual([id(5), id(4), id(3), id(2), id(1)]);
  });

  test("the echo of one's own send replaces the row it already has", () => {
    const client = seeded();
    messageCreated(client, message(3, { content: 'edited by the server' }));
    expect(client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[0]?.content).toBe(
      'edited by the server',
    );
    expect(feed(client)).toHaveLength(3);
  });

  test('an uncached feed is left alone: it loads whole when opened', () => {
    const client = new QueryClient();
    messageCreated(client, message(1));
    expect(cached(client, keys.messages(CH))).toBeUndefined();
  });

  test('a feed with no page yet takes nothing', () => {
    const client = new QueryClient();
    client.setQueryData(keys.messages(CH), { pages: [], pageParams: [] });
    messageCreated(client, message(1));
    expect(feed(client)).toEqual([]);
  });

  test('a reply goes to the end of its thread, oldest first, and not into the feed', () => {
    const client = seeded();
    client.setQueryData(keys.thread(id(1)), pages([message(6, { parentId: id(1), thread: null })]));
    messageCreated(client, message(8, { parentId: id(1), thread: null }));
    messageCreated(client, message(7, { parentId: id(1), thread: null }));
    const thread = client.getQueryData<Pages>(keys.thread(id(1)));
    expect(thread?.pages[0]?.data.map((m) => m.id)).toEqual([id(6), id(7), id(8)]);
    expect(feed(client)).toEqual([id(3), id(2), id(1)]);
  });

  test('a reply to a thread that is not open is not cached', () => {
    const client = seeded();
    messageCreated(client, message(8, { parentId: id(1), thread: null }));
    expect(cached(client, keys.thread(id(1)))).toBeUndefined();
  });

  test('a thread with no page yet takes nothing', () => {
    const client = new QueryClient();
    client.setQueryData(keys.thread(id(1)), { pages: [], pageParams: [] });
    messageCreated(client, message(8, { parentId: id(1), thread: null }));
    expect(client.getQueryData<Pages>(keys.thread(id(1)))?.pages).toEqual([]);
  });

  test("moves the channel's latest activity forward and never back", () => {
    const client = seeded();
    messageCreated(client, message(4, { createdAt: '2026-09-09T09:00:00.000Z' }));
    expect(client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.lastMessageAt).toBe(
      '2026-09-09T09:00:00.000Z',
    );
    messageCreated(client, message(2, { createdAt: '2026-09-09T07:00:00.000Z' }));
    expect(client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.lastMessageAt).toBe(
      '2026-09-09T09:00:00.000Z',
    );
  });
});

describe('a message changes', () => {
  test('a thread summary lands on the root wherever it is cached, and the open questions re-ask', () => {
    const client = seeded();
    client.setQueryData(keys.unresolved(WS), pages([message(2)]));
    const summary = {
      replyCount: 2,
      lastReplyAt: '2026-09-09T08:01:00.000Z',
      resolvedAt: null,
      resolvedBy: null,
    };
    threadUpdated(client, id(2), summary);
    expect(client.getQueryData<Pages>(keys.messages(CH))?.pages[0]?.data[1]?.thread).toEqual(
      summary,
    );
    expect(client.getQueryData<Pages>(keys.unresolved(WS))?.pages[0]?.data[0]?.thread).toEqual(
      summary,
    );
    expect(client.getQueryState(keys.unresolved(WS))?.isInvalidated).toBe(true);
  });

  test('a reaction set replaces the old one; a message nobody caches is a no-op', () => {
    const client = seeded();
    reactionsUpdated(client, id(1), [{ emoji: '👍', userIds: [user.id] }]);
    expect(client.getQueryData<Pages>(keys.messages(CH))?.pages[1]?.data[0]?.reactions).toEqual([
      { emoji: '👍', userIds: [user.id] },
    ]);
    const before = feed(client);
    reactionsUpdated(client, id(99), []);
    expect(feed(client)).toEqual(before);
  });

  test('patching touches only the one message', () => {
    const client = seeded();
    patchMessage(client, id(2), (m) => ({ ...m, content: 'changed' }));
    const all = client
      .getQueryData<Pages>(keys.messages(CH))
      ?.pages.flatMap((p) => p.data.map((m) => m.content));
    expect(all).toEqual(['m3', 'changed', 'm1']);
  });
});

describe('the channel list', () => {
  test("takes the server's counters for the channel the frame names, in whichever workspace", () => {
    const client = seeded();
    const next = { lastReadMessageId: id(2), unreadCount: 4, unreadMentionCount: 1 };
    channelStateChanged(client, CH, next);
    expect(client.getQueryData<Channel[]>(keys.channels(WS))?.[0]?.state).toEqual(next);
    channelStateChanged(client, id(99), next); // not a channel it holds: nothing happens
    expect(client.getQueryData<Channel[]>(keys.channels(WS))).toHaveLength(1);
  });

  test('a channel is added once; with no list cached the list is asked for instead', () => {
    const client = seeded();
    const dm = channel({ id: id(50), name: null, type: 'direct_message', peer: user });
    channelAdded(client, dm);
    channelAdded(client, dm);
    expect(client.getQueryData<Channel[]>(keys.channels(WS))).toHaveLength(2);

    const bare = new QueryClient();
    channelAdded(bare, dm);
    expect(cached(bare, keys.channels(WS))).toBeUndefined();
  });

  test('a revoked channel leaves the list and its messages leave the cache', () => {
    const client = seeded();
    channelsRevoked(client, [CH]);
    expect(client.getQueryData<Channel[]>(keys.channels(WS))).toEqual([]);
    expect(cached(client, keys.messages(CH))).toBeUndefined();
  });

  test('a list that was never cached is not invented by a revocation', () => {
    const client = new QueryClient();
    channelsRevoked(client, [CH]);
    expect(cached(client, keys.channels(WS))).toBeUndefined();
  });
});

describe('the read position', () => {
  test('is the newest id in the feed, or nothing when there is no feed', () => {
    expect(newestMessageId(seeded(), CH)).toBe(id(3));
    expect(newestMessageId(new QueryClient(), CH)).toBeNull();
  });
});
