/** Follow-list content and optimistic choices must never restore hidden or revoked conversations. */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { FollowedThreadsPage } from '@purlay/types';
import { aMessage, IDS, WHEN } from '../testing/fixtures';
import { channelsRevoked, messageHidden, messageRevised, threadUnfollowed } from './cache';
import { keys } from './keys';

type Pages = InfiniteData<FollowedThreadsPage>;
const clientOf = (): QueryClient =>
  new QueryClient({ defaultOptions: { queries: { retry: false } } });
const list = (): Pages => ({
  pageParams: [undefined],
  pages: [
    {
      data: [1, 2].map((n) => ({
        root: aMessage(n, { channelId: n === 1 ? IDS.api : IDS.incidents }),
        activityAt: WHEN,
        unread: { count: 0, firstUnreadMessageId: null },
      })),
      nextCursor: null,
    },
  ],
});
const rootIds = (client: QueryClient, unreadOnly = false): string[] =>
  client
    .getQueryData<Pages>(keys.followedThreads(IDS.workspace, unreadOnly))
    ?.pages.flatMap((page) => page.data.map((row) => row.root.id)) ?? [];

describe('followed conversation caches', () => {
  test('updates an edited root immediately in both filters', () => {
    const client = clientOf();
    for (const filter of [false, true])
      client.setQueryData(keys.followedThreads(IDS.workspace, filter), list());
    messageRevised(client, {
      channelId: IDS.api,
      messageId: aMessage(1).id,
      parentId: null,
      content: 'Updated handover',
      editedAt: WHEN,
      deletedAt: null,
      mentions: [],
    });
    for (const filter of [false, true])
      expect(
        client.getQueryData<Pages>(keys.followedThreads(IDS.workspace, filter))?.pages[0]?.data[0]
          ?.root.content,
      ).toBe('Updated handover');
    client.clear();
  });

  test('removes a personally hidden root immediately and keeps unrelated rows', () => {
    const client = clientOf();
    client.setQueryData(keys.followedThreads(IDS.workspace), list());
    messageHidden(client, aMessage(1).id, WHEN, IDS.api);
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    client.clear();
  });

  test('rolls back a refused unfollow in both filters', () => {
    const client = clientOf();
    for (const filter of [false, true])
      client.setQueryData(keys.followedThreads(IDS.workspace, filter), list());
    const undo = threadUnfollowed(client, aMessage(1).id);
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    expect(rootIds(client, true)).toEqual([aMessage(2).id]);
    undo();
    expect(rootIds(client)).toEqual([aMessage(1).id, aMessage(2).id]);
    expect(rootIds(client, true)).toEqual(rootIds(client));
    client.clear();
  });

  test('a refused unfollow cannot restore content after access was revoked', () => {
    const client = clientOf();
    client.setQueryData(keys.followedThreads(IDS.workspace), list());
    const undo = threadUnfollowed(client, aMessage(1).id);
    channelsRevoked(client, [IDS.api]);
    undo();
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    client.clear();
  });

  test('an in-flight old page cannot restore a conversation after revocation', async () => {
    const client = clientOf();
    const key = keys.followedThreads(IDS.workspace);
    const pending = Promise.withResolvers<Pages>();
    const current = list();
    const visible = {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        data: page.data.filter((row) => row.root.channelId !== IDS.api),
      })),
    };
    client.setQueryData(key, current);
    let calls = 0;
    const fetch = async (): Promise<Pages> => {
      calls += 1;
      return calls === 1 ? await pending.promise : visible;
    };
    const first = client.query({ queryKey: key, queryFn: fetch }).catch(() => undefined);
    const exposed: boolean[] = [];
    const stop = client.getQueryCache().subscribe(() => {
      exposed.push(rootIds(client).includes(aMessage(1).id));
    });
    channelsRevoked(client, [IDS.api]);
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    pending.resolve(current);
    await first;
    await client.query({ queryKey: key, queryFn: fetch });
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    expect(calls).toBeGreaterThan(1);
    expect(exposed).not.toContain(true);
    stop();
    client.clear();
  });

  test('a first followed page with no cached rows cannot publish revoked words after arriving late', async () => {
    const client = clientOf();
    const key = keys.followedThreads(IDS.workspace);
    const pending = Promise.withResolvers<Pages>();
    const current = list();
    const visible = {
      ...current,
      pages: current.pages.map((page) => ({
        ...page,
        data: page.data.filter((row) => row.root.channelId !== IDS.api),
      })),
    };
    let calls = 0;
    const fetch = (): Promise<Pages> => {
      calls++;
      return calls === 1 ? pending.promise : Promise.resolve(visible);
    };
    const first = client.query({ queryKey: key, queryFn: fetch }).catch(() => undefined);
    expect(client.getQueryData(key) === undefined).toBe(true);
    const exposed: boolean[] = [];
    const stop = client.getQueryCache().subscribe(() => {
      exposed.push(rootIds(client).includes(aMessage(1).id));
    });
    try {
      channelsRevoked(client, [IDS.api]);
      pending.resolve(current);
      await first;
      await client.query({ queryKey: key, queryFn: fetch });
      expect(rootIds(client)).toEqual([aMessage(2).id]);
      expect(exposed.includes(true)).toBe(false);
    } finally {
      pending.resolve(current);
      stop();
      client.clear();
    }
  });

  test('hiding or deleting a root while an unfollow is pending invalidates its undo', () => {
    for (const hide of [true, false]) {
      const client = clientOf();
      client.setQueryData(keys.followedThreads(IDS.workspace), list());
      const undo = threadUnfollowed(client, aMessage(1).id);
      if (hide) messageHidden(client, aMessage(1).id, WHEN, IDS.api);
      else
        messageRevised(client, {
          channelId: IDS.api,
          messageId: aMessage(1).id,
          parentId: null,
          content: '',
          editedAt: null,
          deletedAt: WHEN,
          mentions: [],
        });
      undo();
      expect(rootIds(client)).toEqual([aMessage(2).id]);
      client.clear();
    }
  });

  test('a newer authoritative page cannot be overwritten by an old refused choice', () => {
    const client = clientOf();
    const key = keys.followedThreads(IDS.workspace);
    client.setQueryData(key, list());
    const undo = threadUnfollowed(client, aMessage(1).id);
    const fresh = list();
    client.setQueryData(key, {
      ...fresh,
      pages: fresh.pages.map((page) => ({
        ...page,
        data: page.data
          .filter((row) => row.root.id !== aMessage(1).id)
          .map((row) => ({ ...row, root: { ...row.root, content: 'Fresh source words' } })),
      })),
    });
    undo();
    expect(rootIds(client)).toEqual([aMessage(2).id]);
    expect(client.getQueryData<Pages>(key)?.pages[0]?.data[0]?.root.content).toBe(
      'Fresh source words',
    );
    client.clear();
  });
});
