/** Catch-up copies must learn live edits and forget revoked private channel content. */
import { describe, expect, test } from 'bun:test';
import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { ChannelCatchUp, MessageRevision } from '@purlay/types';
import { IDS, aMessage, messageIdAt } from '../testing/fixtures';
import {
  channelsRevoked,
  channelStateChanged,
  messageHidden,
  messageRevised,
  threadUpdated,
} from './cache';
import { keys } from './keys';

type Pages = InfiniteData<ChannelCatchUp, string | undefined>;
const WHEN = '2026-11-07T12:00:00.000Z';
const seed = (
  client: QueryClient,
  channelId: string = IDS.api,
): ReturnType<typeof keys.unreads> => {
  const number = channelId === IDS.api ? 1 : 2;
  const root = aMessage(number, {
    channelId,
    content: 'Old handover',
    thread: { replyCount: 1, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null },
  });
  const key = keys.unreads(channelId, null, 2);
  client.setQueryData<Pages>(key, {
    pageParams: [undefined],
    pages: [
      {
        roots: { data: [root], nextCursor: null },
        threads: [{ root, firstUnreadMessageId: messageIdAt(number + 10), unreadCount: 1 }],
        nextThreadCursor: null,
      },
    ],
  });
  return key;
};
const held = (client: QueryClient): ChannelCatchUp | undefined =>
  client.getQueryData<Pages>(keys.unreads(IDS.api, null, 2))?.pages[0];
const revision: MessageRevision = {
  channelId: IDS.api,
  messageId: messageIdAt(1),
  parentId: null,
  content: 'Updated handover',
  editedAt: WHEN,
  deletedAt: null,
  mentions: [],
};

describe('live catch-up cache', () => {
  test('edits and thread summaries update both root and waiting-thread copies without inventing unread counts', () => {
    const client = new QueryClient();
    seed(client);
    messageRevised(client, revision);
    expect(held(client)?.roots.data[0]?.content).toBe('Updated handover');
    expect(held(client)?.threads[0]?.root.content).toBe('Updated handover');
    threadUpdated(client, messageIdAt(1), {
      replyCount: 4,
      lastReplyAt: WHEN,
      resolvedAt: null,
      resolvedBy: null,
    });
    expect(held(client)?.threads[0]?.root.thread?.replyCount).toBe(4);
    expect(held(client)?.threads[0]?.unreadCount).toBe(1);
    client.clear();
  });

  test('deletion removes the unread root while retaining a blank parent for its waiting thread', () => {
    const client = new QueryClient();
    seed(client);
    messageRevised(client, { ...revision, content: '', editedAt: null, deletedAt: WHEN });
    expect(held(client)?.roots.data).toEqual([]);
    expect(held(client)?.threads[0]?.root).toMatchObject({ content: '', deletedAt: WHEN });
    client.clear();
  });

  test('a private hide stays hidden when a later shared edit arrives', () => {
    const client = new QueryClient();
    seed(client);
    messageHidden(client, messageIdAt(1), WHEN);
    messageRevised(client, revision);
    expect(held(client)?.roots.data).toEqual([]);
    expect(held(client)?.threads[0]?.root).toMatchObject({
      hiddenForMe: true,
      content: '',
      deletedAt: WHEN,
      attachments: [],
    });
    client.clear();
  });

  test('revocation removes every private catch-up page of that channel and keeps unrelated channels', () => {
    const client = new QueryClient();
    const gone = seed(client);
    const older = keys.unreads(IDS.api, messageIdAt(9), 3);
    client.setQueryData(older, client.getQueryData(gone));
    const remains = seed(client, IDS.deploys);
    channelsRevoked(client, [IDS.api]);
    expect(client.getQueryData(gone)).toBeUndefined();
    expect(client.getQueryData(older)).toBeUndefined();
    expect(client.getQueryData(remains)).toBeDefined();
    client.clear();
  });

  test('an authoritative state receipt refreshes an existing page even when its count and position are unchanged', () => {
    const client = new QueryClient();
    const key = seed(client);
    channelStateChanged(client, IDS.api, {
      lastReadMessageId: null,
      unreadCount: 2,
      unreadMentionCount: 0,
    });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
});
