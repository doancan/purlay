/** Source frames keep the workspace catalogue current even when historical indexing is finished. */
import { expect, test } from 'bun:test';
import { QueryClient, QueryObserver, type InfiniteData } from '@tanstack/react-query';
import type { SharedPage } from '@purlay/types';
import { BOB, IDS, WHEN, messageIdAt } from '../testing/fixtures';
import { messageCreated, messageHidden, messageRevised } from './cache';
import { keys } from './keys';
import { aMessage } from '../testing/fixtures';
import { channelAccessRevoked, workspaceAccessChanged } from './access-change';
import { aChannel } from '../testing/fixtures';

test('a source removal during an initial read starts its replacement instead of leaving a pending idle screen', async () => {
  const client = new QueryClient();
  const first = Promise.withResolvers<SharedPage>();
  const second = Promise.withResolvers<SharedPage>();
  let reads = 0;
  const observer = new QueryObserver(client, {
    queryKey: keys.shared(IDS.workspace, { view: 'links' }),
    queryFn: (): Promise<SharedPage> => (++reads === 1 ? first.promise : second.promise),
  });
  const stop = observer.subscribe(() => undefined);
  try {
    expect(reads).toBe(1);
    messageHidden(client, messageIdAt(2), WHEN, IDS.api);
    await Promise.resolve();
    expect(reads).toBe(2);
    second.resolve({ data: [], nextCursor: null, indexing: false });
    await observer.refetch();
    expect(observer.getCurrentResult().data?.data).toEqual([]);
  } finally {
    first.resolve({ data: [], nextCursor: null, indexing: false });
    second.resolve({ data: [], nextCursor: null, indexing: false });
    stop();
    client.clear();
  }
});

test.each(['workspace', 'channel'] as const)(
  'a %s access loss clears every old Shared page before a replacement response',
  (scope) => {
    const client = new QueryClient();
    client.setQueryData(keys.channels(IDS.workspace), [aChannel(IDS.api, 'private')]);
    const key = keys.shared(IDS.workspace, { view: 'links' });
    client.setQueryData(key, {
      pages: [{ data: ['Old private content'], nextCursor: null, indexing: false }],
      pageParams: [undefined],
    });
    if (scope === 'workspace') workspaceAccessChanged(client, IDS.workspace);
    else channelAccessRevoked(client, [IDS.api]);
    expect(client.getQueryData(key) === undefined).toBe(true);
    client.clear();
  },
);

test.each(['edit', 'delete', 'hide'] as const)(
  'a root %s refreshes Shared; removed sources disappear before its HTTP answer',
  (change) => {
    const client = new QueryClient();
    const messageId = messageIdAt(2);
    const key = keys.shared(IDS.workspace, { view: 'links' });
    const data: InfiniteData<SharedPage> = {
      pages: [
        {
          data: [
            {
              kind: 'link',
              key: 'a'.repeat(64),
              messageId,
              channelId: IDS.api,
              parentId: null,
              sender: BOB,
              sourceName: null,
              sentAt: WHEN,
              link: { url: 'http://intranet/old', label: 'Old' },
            },
          ],
          indexing: false,
          nextCursor: null,
        },
      ],
      pageParams: [undefined],
    };
    client.setQueryData(key, data);
    if (change === 'hide') messageHidden(client, messageId, WHEN, IDS.api);
    else
      messageRevised(client, {
        messageId,
        channelId: IDS.api,
        parentId: null,
        content: '',
        editedAt: WHEN,
        deletedAt: change === 'delete' ? WHEN : null,
        mentions: [],
      });
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    if (change !== 'edit')
      expect(client.getQueryData<InfiniteData<SharedPage>>(key)?.pages[0]?.data).toEqual([]);
    client.clear();
  },
);

test('a new source message refreshes the already loaded Shared list', () => {
  const client = new QueryClient();
  const key = keys.shared(IDS.workspace, { view: 'files' });
  client.setQueryData(key, {
    pages: [{ data: [], indexing: false, nextCursor: null }],
    pageParams: [undefined],
  });
  messageCreated(client, aMessage(3));
  expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  client.clear();
});
