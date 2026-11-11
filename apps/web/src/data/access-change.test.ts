/** Ownership evidence preserves other content; uncertain previous grants cannot keep cached words. */
import { describe, expect, test } from 'bun:test';
import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query';
import type { Attachment, Message } from '@purlay/types';
import { aChannel, aMessage, aSession, IDS } from '../testing/fixtures';
import {
  accountAccessChanged,
  channelAccessRevoked,
  reconcileAccountOnCommit,
  workspaceAccessChanged,
} from './access-change';
import { keys } from './keys';

describe('cached access ownership', () => {
  test.each(['membership', 'chat'] as const)(
    'a current closed %s clears an active content observer without another private request',
    async (closed) => {
      const client = new QueryClient();
      const before = aSession();
      const original = aMessage(1);
      let reads = 0;
      const observer = new QueryObserver(client, {
        queryKey: keys.message(original.id),
        queryFn: (): Promise<Message> => {
          reads++;
          return Promise.resolve(original);
        },
        staleTime: Infinity,
      });
      const stop = observer.subscribe(() => undefined);
      try {
        await observer.refetch();
        expect(reads).toBe(1);
        expect(observer.getCurrentResult().data).toEqual(original);
        const after = {
          ...before,
          ...(closed === 'membership' ? { memberships: [] } : { modules: [] }),
        };
        client.setQueryData(keys.me, after);
        accountAccessChanged(client, before, after);
        expect(observer.getCurrentResult().data === undefined).toBe(true);
        expect(client.getQueryData(keys.message(original.id)) === undefined).toBe(true);
        expect(reads).toBe(1);
      } finally {
        stop();
        client.clear();
      }
    },
  );

  test('a readable other-workspace window target and reply retain their versions and file text without a card lookup', () => {
    const client = new QueryClient();
    const otherWorkspace = 'other-workspace';
    const otherChannel = 'other-channel';
    client.setQueryData(keys.channels(otherWorkspace), [
      aChannel(otherChannel, 'other', { workspaceId: otherWorkspace }),
    ]);
    const attachment: Attachment = {
      id: 'other-file',
      fileName: 'handover.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      kind: 'file',
      width: null,
      height: null,
    };
    const target = aMessage(3, { channelId: otherChannel, attachments: [attachment] });
    const parent = aMessage(1, { channelId: otherChannel });
    const reply = aMessage(2, { channelId: otherChannel, parentId: parent.id });
    client.setQueryData(keys.messagesAround(otherChannel, target.id), {
      pages: [{ data: [reply], target, nextCursor: null }],
      pageParams: [undefined],
    });
    const retained = [
      keys.messageVersions(target.id),
      keys.messageVersions(parent.id),
      keys.attachmentText(attachment.id),
    ];
    for (const key of retained) client.setQueryData(key, 'Other readable content');
    workspaceAccessChanged(client, IDS.workspace);
    expect(retained.map((key) => client.getQueryData(key))).toEqual(
      retained.map(() => 'Other readable content'),
    );
    client.clear();
  });

  test('conflicting channel ownership is uncertain and cannot retain old words', () => {
    const client = new QueryClient();
    client.setQueryData(keys.channels(IDS.workspace), [aChannel(IDS.api, 'alpha')]);
    client.setQueryData(keys.channels('other'), [
      aChannel(IDS.api, 'ambiguous', { workspaceId: 'other' }),
    ]);
    const original = aMessage(1);
    client.setQueryData(keys.message(original.id), original);
    workspaceAccessChanged(client, IDS.workspace);
    expect(client.getQueryData(keys.message(original.id)) === undefined).toBe(true);
    client.clear();
  });

  test('personal settings and an empty revocation keep their data', () => {
    const client = new QueryClient();
    const personal = [keys.me, keys.quietHours, keys.missedMail, keys.channelGroups(IDS.workspace)];
    for (const key of personal) client.setQueryData(key, 'Personal preference');
    client.setQueryData(keys.attachmentText('unknown-file'), 'Unchanged file');
    channelAccessRevoked(client, []);
    expect(client.getQueryData(keys.attachmentText('unknown-file'))).toBe('Unchanged file');
    workspaceAccessChanged(client, IDS.workspace);
    expect(personal.map((key) => client.getQueryData(key))).toEqual(
      personal.map(() => 'Personal preference'),
    );
    client.clear();
  });

  test('a receipt for another identity cannot apply the previous account membership changes to fresh content', () => {
    const client = new QueryClient();
    const before = aSession();
    const after = {
      ...aSession(),
      user: { ...aSession().user, id: 'another-person' },
      memberships: [],
    };
    const original = aMessage(1);
    client.setQueryData(keys.message(original.id), original);
    accountAccessChanged(client, before, after);
    expect(client.getQueryData(keys.message(original.id))).toEqual(original);
    client.clear();
  });
});

class CountedQueryCache extends QueryCache {
  listenerCount(): number {
    return this.listeners.size;
  }
}

describe('one fetched account receipt', () => {
  test('only its network commit reconciles once, then releases its subscription', async () => {
    const cache = new CountedQueryCache();
    const client = new QueryClient({ queryCache: cache });
    const before = aSession();
    const next = { ...before, modules: [] };
    client.setQueryData(keys.me, before);
    const original = aMessage(1);
    client.setQueryData(keys.message(original.id), original);
    try {
      reconcileAccountOnCommit(client, before, new AbortController().signal);
      expect(cache.listenerCount()).toBe(1);
      // A different Query's network success and a manual edit of this receipt are not its answer.
      await client.query({ queryKey: ['unrelated'], queryFn: () => Promise.resolve('done') });
      client.setQueryData(keys.me, next);
      expect(cache.listenerCount()).toBe(1);
      expect(client.getQueryData(keys.message(original.id))).toEqual(original);
      await client.query({ queryKey: keys.me, queryFn: () => Promise.resolve(next) });
      expect(cache.listenerCount()).toBe(0);
      expect(client.getQueryData(keys.message(original.id)) === undefined).toBe(true);
      client.setQueryData(keys.message(original.id), original);
      await client.query({ queryKey: keys.me, queryFn: () => Promise.resolve(next) });
      expect(client.getQueryData(keys.message(original.id))).toEqual(original);
    } finally {
      client.clear();
    }
  });

  test.each(['abort', 'remove', 'error'] as const)(
    '%s releases the old subscription without applying it to a future receipt',
    async (terminal) => {
      const cache = new CountedQueryCache();
      const client = new QueryClient({ queryCache: cache });
      const before = aSession();
      client.setQueryData(keys.me, before);
      const controller = new AbortController();
      try {
        reconcileAccountOnCommit(client, before, controller.signal);
        expect(cache.listenerCount()).toBe(1);
        if (terminal === 'abort') controller.abort();
        else if (terminal === 'remove') client.removeQueries({ queryKey: keys.me, exact: true });
        else
          await client
            .query({
              queryKey: keys.me,
              queryFn: () => Promise.reject(new Error('offline')),
              retry: false,
            })
            .catch(() => undefined);
        expect(cache.listenerCount()).toBe(0);
        const fresh = aMessage(2);
        client.setQueryData(keys.message(fresh.id), fresh);
        await client.query({
          queryKey: keys.me,
          queryFn: () => Promise.resolve({ ...before, modules: [] }),
        });
        expect(client.getQueryData(keys.message(fresh.id))).toEqual(fresh);
      } finally {
        controller.abort();
        client.clear();
      }
    },
  );

  test('an already aborted or absent account query does not retain a subscription', () => {
    const cache = new CountedQueryCache();
    const client = new QueryClient({ queryCache: cache });
    const controller = new AbortController();
    reconcileAccountOnCommit(client, undefined, controller.signal);
    expect(cache.listenerCount()).toBe(0);
    controller.abort();
    client.setQueryData(keys.me, aSession());
    reconcileAccountOnCommit(client, aSession(), controller.signal);
    expect(cache.listenerCount()).toBe(0);
    client.clear();
  });
});
