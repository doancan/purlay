/** The follow list as a reader meets it: navigation, receipts, cursor paging and refused choices. */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type {
  FollowedThread,
  FollowedThreadsPage,
  FollowedThreadsQuery,
  ThreadFollow,
} from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { installDom } from '../../../testing/dom';
import { expectNoAxeViolations } from '../../../testing/axe';
import { aMessage, aSignedInApi, IDS, WHEN } from '../../../testing/fixtures';
import { expectFocusOn } from '../../../testing/focus';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { FeedPortsContext, type FeedPorts } from '../channel/feed-ports';
import { useSetThreadFollow } from '../threads/follow-toggle';
import { keys } from '../../../data/keys';

installDom();
const item = (n: number): FollowedThread => ({
  root: aMessage(n, { content: `Shift handover ${String(n)}` }),
  activityAt: WHEN,
  unread: { count: 0, firstUnreadMessageId: null },
});
const page = (...data: FollowedThread[]): FollowedThreadsPage => ({ data, nextCursor: null });
const visit = async (
  api: Partial<Api>,
  path = '/w/acme/followed',
  locale: 'en' | 'tr' = 'en',
): ReturnType<typeof renderApp> =>
  await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path, locale, api: aSignedInApi(api) },
  );
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const FollowFromThread = (): React.JSX.Element => {
  const choose = useSetThreadFollow(aMessage(1).id);
  return (
    <button
      type="button"
      onClick={() => {
        choose(true);
      }}
    >
      Follow root
    </button>
  );
};

describe('followed conversations', () => {
  test('announces a pending first read, then explains an empty list without acknowledging anything', async () => {
    const pending = Promise.withResolvers<FollowedThreadsPage>();
    const view = await visit({ followedThreads: () => pending.promise });
    const loading = await view.findByText('Loading followed conversations…');
    expect(loading.closest('[role="status"]')?.getAttribute('aria-busy')).toBe('true');
    expect(view.queryByRole('heading', { name: 'No followed conversations yet' })).toBeNull();
    await act(async () => {
      pending.resolve(page());
      await pending.promise;
    });
    await view.findByRole('heading', { name: 'No followed conversations yet' });
    expect(view.queryByText('Loading followed conversations…')).toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test.each([
    [
      'en',
      'No unread replies in your followed conversations',
      'All',
      'No followed conversations yet',
    ],
    [
      'tr',
      'Takip ettiğin konuşmalarda okunmamış yanıt yok',
      'Tümü',
      'Henüz takip edilen konuşma yok',
    ],
  ] as const)(
    'distinguishes an empty unread filter from no follows in %s',
    async (locale, unreadTitle, all, emptyTitle) => {
      const calls: FollowedThreadsQuery[] = [];
      const view = await visit(
        {
          followedThreads: (_workspace, query = {}) => {
            calls.push(query);
            return Promise.resolve(page());
          },
        },
        '/w/acme/followed?filter=unread',
        locale,
      );
      await view.findByRole('heading', { name: unreadTitle });
      await person().click(view.getByRole('button', { name: all }));
      await view.findByRole('heading', { name: emptyTitle });
      expect(calls.map((query) => query.unreadOnly)).toEqual([true, false]);
      view.unmount();
    },
  );

  test('retries an initial error and keeps focus on the heading when the last conversation is unfollowed', async () => {
    let reads = 0;
    let following = true;
    const view = await visit({
      followedThreads: () => {
        reads += 1;
        if (reads === 1) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        return Promise.resolve(following ? page(item(1)) : page());
      },
      setThreadFollow: () => {
        following = false;
        return Promise.resolve({ following });
      },
    });
    await view.findByRole('heading', { name: 'Conversations could not be loaded' });
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await view.findByRole('link', { name: /Shift handover 1/ });
    expect(reads).toBe(2);
    await person().click(view.getByRole('button', { name: 'Unfollow' }));
    expectFocusOn(view.getByRole('heading', { level: 1, name: 'Followed conversations' }));
    await view.findByRole('heading', { name: 'No followed conversations yet' });
    view.unmount();
  });

  test('an unknown receipt asks to join and a tombstone never shows the deleted words', async () => {
    const row = { ...item(1), root: { ...item(1).root, deletedAt: WHEN }, unread: null };
    const view = await visit({ followedThreads: () => Promise.resolve(page(row)) });
    await view.findByText('Join the channel to track unread replies');
    expect(view.queryByText('No unread replies')).toBeNull();
    expect(view.queryByText('Shift handover 1')).toBeNull();
    expect(view.getByText('This message was deleted.')).toBeDefined();
    view.unmount();
  });

  test('links read conversations to the thread and waiting ones to their first unread reply, without acknowledging either', async () => {
    const waiting = { ...item(2), unread: { count: 1, firstUnreadMessageId: aMessage(3).id } };
    const view = await visit({ followedThreads: () => Promise.resolve(page(item(1), waiting)) });
    const first = await view.findByRole('link', { name: /Shift handover 1/ });
    expect(first.getAttribute('href')).toContain(`thread=${item(1).root.id}`);
    expect(
      (await view.findByRole('link', { name: /Shift handover 2/ })).getAttribute('href'),
    ).toContain(`message=${aMessage(3).id}`);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('pages with the exact composite cursor and keeps earlier rows when a later page fails', async () => {
    const calls: FollowedThreadsQuery[] = [];
    let failed = false;
    const cursor = { activityAt: '2026-11-07T12:00:00.000001Z', rootId: item(1).root.id };
    const view = await visit({
      followedThreads: (_workspace, query = {}) => {
        calls.push(query);
        if ('beforeRootId' in query) {
          if (failed) return Promise.resolve(page(item(2)));
          failed = true;
          return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        }
        return Promise.resolve({ ...page(item(1)), nextCursor: cursor });
      },
    });
    await view.findByRole('link', { name: /Shift handover 1/ });
    await person().click(view.getByRole('button', { name: 'Earlier conversations' }));
    await view.findByRole('heading', { name: 'The list could not be updated' });
    expect(view.getByRole('link', { name: /Shift handover 1/ })).toBeDefined();
    expect(calls.at(-1)).toEqual({
      unreadOnly: false,
      beforeActivityAt: cursor.activityAt,
      beforeRootId: cursor.rootId,
    });
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await view.findByRole('link', { name: /Shift handover 2/ });
    expect(view.getByRole('link', { name: /Shift handover 1/ })).toBeDefined();
    expect(calls).toHaveLength(3);
    expect(calls.at(-1)).toEqual(calls[1]);
    view.unmount();
  });

  test('puts the unread filter in the address and reads the server’s unread relation', async () => {
    const calls: FollowedThreadsQuery[] = [];
    const view = await visit({
      followedThreads: (_workspace, query = {}) => {
        calls.push(query);
        return Promise.resolve(page(item(1)));
      },
    });
    await view.findByRole('link', { name: /Shift handover 1/ });
    await person().click(view.getByRole('button', { name: 'Unread' }));
    await settle();
    expect(calls.some((query) => query.unreadOnly === true)).toBe(true);
    expect(view.getByRole('button', { name: 'Unread' }).getAttribute('aria-pressed')).toBe('true');
    view.unmount();
  });

  test('unfollows immediately, moves keyboard focus and restores a refused choice', async () => {
    const pending = Promise.withResolvers<ThreadFollow>();
    let reads = 0;
    const view = await visit({
      followedThreads: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(page(item(1), item(2)))
          : Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      },
      setThreadFollow: async () => await pending.promise,
    });
    const link = await view.findByRole('link', { name: /Shift handover 1/ });
    const row = link.closest('li');
    if (row === null) throw new Error('Missing conversation row');
    await person().click(within(row).getByRole('button', { name: 'Unfollow' }));
    expect(view.queryByRole('link', { name: /Shift handover 1/ })).toBeNull();
    expectFocusOn(view.getByRole('link', { name: /Shift handover 2/ }));
    await act(async () => {
      pending.reject(new ApiError(0, 'NETWORK', 'offline'));
      await Promise.resolve();
    });
    await view.findByRole('link', { name: /Shift handover 1/ });
    await view.findByText(/You are still following this thread/);
    await view.findByRole('heading', { name: 'The list could not be updated' });
    view.unmount();
  });

  test('returning to the page reads choices made elsewhere once, and never reads while away', async () => {
    let visible = true;
    let notify: (() => void) | undefined;
    let current = page(item(1));
    let reads = 0;
    const ports: FeedPorts = {
      pageVisible: () => visible,
      onPageVisibility: (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      whenVisible: () => () => undefined,
      whenResized: () => () => undefined,
      schedule: () => () => undefined,
      clock: { now: () => new Date(WHEN) },
    };
    const view = await renderApp(
      <FeedPortsContext.Provider value={ports}>
        <Outlet />
        <Toaster dismissLabel="Close" />
      </FeedPortsContext.Provider>,
      {
        path: '/w/acme/followed',
        api: aSignedInApi({
          followedThreads: () => {
            reads += 1;
            return Promise.resolve(current);
          },
        }),
      },
    );
    await view.findByRole('link', { name: /Shift handover 1/ });
    visible = false;
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    expect(reads).toBe(1);
    current = page(item(2));
    visible = true;
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    await view.findByRole('link', { name: /Shift handover 2/ });
    expect(view.queryByRole('link', { name: /Shift handover 1/ })).toBeNull();
    await act(async () => {
      notify?.();
      await Promise.resolve();
    });
    expect(reads).toBe(2);
    view.unmount();
  });

  test('following from a thread refreshes a previously empty cached list', async () => {
    const view = await renderApp(
      <>
        <FollowFromThread />
        <Toaster dismissLabel="Close" />
      </>,
      { api: aSignedInApi({ setThreadFollow: () => Promise.resolve({ following: true }) }) },
    );
    view.world.client.setQueryData(keys.followedThreads(IDS.workspace), {
      pages: [page()],
      pageParams: [undefined],
    });
    view.world.client.setQueryData(keys.threadFollow(aMessage(1).id), { following: false });
    await person().click(view.getByRole('button', { name: 'Follow root' }));
    await settle();
    expect(
      view.world.client.getQueryState(keys.followedThreads(IDS.workspace))?.isInvalidated,
    ).toBe(true);
    view.unmount();
  });
});
