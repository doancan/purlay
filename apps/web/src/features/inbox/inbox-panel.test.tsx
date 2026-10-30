/**
 * The inbox panel (D-208) as a person meets it, from the rail: what it asks the server for, its
 * categories, See all, reading from it — and the hardening: a read is never painted back by an
 * answer that was already on its way, and a category's Mark all read reads only what it shows.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { Notification, NotificationPage, ReadNotificationsRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { PANEL_LIMIT } from '../../data/queries';
import { markLocally } from './read';

installDom();

type Asked = NonNullable<Parameters<Api['notifications']>[1]>;

const id = (n: number): string =>
  `00000000-0000-4000-8000-${(0xd00 + n).toString(16).padStart(12, '0')}`;

const told = (
  n: number,
  type: Notification['type'],
  readAt: string | null = null,
): Notification => ({
  id: id(n),
  type,
  channelId: IDS.api,
  message: aMessage(n, { sender: n % 2 === 0 ? ALICE : BOB, content: `words ${String(n)}` }),
  thread: null,
  createdAt: '2026-09-09T08:00:00.000Z',
  readAt,
});

const page = (
  data: readonly Notification[],
  nextCursor: string | null = null,
): NotificationPage => ({
  data: [...data],
  nextCursor,
});

const visit = async (
  api: Partial<Api>,
  path = `/w/acme/c/${IDS.api}`,
): ReturnType<typeof renderApp> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path, api: aSignedInApi(api) },
  );
  await settle();
  return view;
};

type View = Awaited<ReturnType<typeof visit>>;

const places = (view: View): HTMLElement => view.getByRole('navigation', { name: 'Places' });

const openPanel = async (view: View): Promise<HTMLElement> => {
  await person().click(within(places(view)).getByRole('button', { name: /Inbox/ }));
  await settle();
  return view.getByRole('dialog', { name: 'Inbox' });
};

describe('the inbox panel', () => {
  test('opens from the rail without leaving the channel, and asks for one page of ten', async () => {
    const asked: Asked[] = [];
    const view = await visit({
      notifications: (_workspace, at = {}) => {
        asked.push(at);
        return Promise.resolve(page([told(1, 'mention'), told(2, 'direct_message')], id(2)));
      },
    });
    // Closed, nothing is asked.
    expect(asked).toEqual([]);
    const panel = await openPanel(view);
    expect(asked).toEqual([{ limit: PANEL_LIMIT }]);
    expect(within(panel).getByText('words 1')).toBeDefined();
    expect(within(panel).getByText('words 2')).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    await expectNoAxeViolations(panel);
    view.unmount();
  });

  test('a category is a server query, and See all lands on the inbox in the same category', async () => {
    const asked: Asked[] = [];
    const view = await visit({
      notifications: (_workspace, at = {}) => {
        asked.push(at);
        return Promise.resolve(page(at.types === 'mention' ? [told(3, 'mention')] : []));
      },
    });
    const panel = await openPanel(view);
    const categories = within(within(panel).getByRole('group', { name: 'Category' }));
    await person().click(categories.getByRole('button', { name: 'Mentions' }));
    await settle();
    expect(asked.at(-1)).toEqual({ limit: PANEL_LIMIT, types: 'mention' });
    expect(within(panel).getByText('words 3')).toBeDefined();
    await person().click(within(panel).getByRole('link', { name: 'See all' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/inbox?category=mentions');
    expect(view.queryByRole('dialog', { name: 'Inbox' })).toBeNull();
    const onPage = within(view.getByRole('group', { name: 'Category' }));
    expect(onPage.getByRole('button', { name: 'Mentions' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    // The page asks the same category, a page at a time.
    expect(asked.at(-1)).toEqual({ types: 'mention' });
    view.unmount();
  });

  test('threads are replies and resolutions together; an empty category says which', async () => {
    const asked: Asked[] = [];
    const view = await visit({
      notifications: (_workspace, at = {}) => {
        asked.push(at);
        return Promise.resolve(page([]));
      },
    });
    const panel = await openPanel(view);
    await person().click(
      within(within(panel).getByRole('group', { name: 'Category' })).getByRole('button', {
        name: 'Threads',
      }),
    );
    await settle();
    expect(asked.at(-1)).toEqual({ limit: PANEL_LIMIT, types: 'thread_reply,thread_resolved' });
    expect(within(panel).getByText('Nothing in your threads')).toBeDefined();
    view.unmount();
  });

  test('opening a row reads it, closes the panel and goes to the message', async () => {
    const reads: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () => Promise.resolve(page([told(4, 'mention')])),
      readNotifications: (input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    const panel = await openPanel(view);
    await person().click(within(panel).getByRole('button', { name: /words 4/ }));
    await settle();
    expect(reads).toEqual([{ ids: [id(4)] }]);
    expect(view.queryByRole('dialog', { name: 'Inbox' })).toBeNull();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('in a category, Mark all read reads the rows shown — never "up to", which reads the rest', async () => {
    const reads: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: (_workspace, at = {}) =>
        Promise.resolve(page(at.types === 'direct_message' ? [told(5, 'direct_message')] : [])),
      readNotifications: (input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    const panel = await openPanel(view);
    await person().click(
      within(within(panel).getByRole('group', { name: 'Category' })).getByRole('button', {
        name: 'Direct',
      }),
    );
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Mark all read' }));
    await settle();
    expect(reads).toEqual([{ ids: [id(5)] }]);
    view.unmount();
  });
});

describe('reading, hardened', () => {
  test('a read is painted in every view of the inbox: pages a list loaded and the panel’s one page', async () => {
    const view = await visit({ notifications: () => Promise.resolve(page([])) });
    const { client } = view.world;
    const at = '2026-09-09T09:00:00.000Z';
    client.setQueryData(keys.notifications(IDS.workspace), {
      pages: [page([told(6, 'mention')]), page([told(7, 'mention')])],
      pageParams: [undefined, id(6)],
    });
    client.setQueryData(keys.notificationsPanel(IDS.workspace, 'all'), page([told(6, 'mention')]));
    markLocally(client, IDS.workspace, (n) => n.id === id(6) || n.id === id(7), at);
    const pages = client.getQueryData<{ pages: NotificationPage[] }>(
      keys.notifications(IDS.workspace),
    );
    expect(pages?.pages.flatMap((p) => p.data.map((n) => n.readAt))).toEqual([at, at]);
    const panel = client.getQueryData<NotificationPage>(
      keys.notificationsPanel(IDS.workspace, 'all'),
    );
    expect(panel?.data.map((n) => n.readAt)).toEqual([at]);
    view.unmount();
  });

  test('an answer already on its way when the person reads does not paint the row unread again', async () => {
    const held: { answer?: (page: NotificationPage) => void } = {};
    let calls = 0;
    const view = await visit({
      notifications: () => {
        calls += 1;
        // The first answer at once; the second — a frame's read-again — is held until after the read.
        if (calls === 1) return Promise.resolve(page([told(8, 'mention')]));
        return new Promise((resolve) => {
          held.answer = resolve;
        });
      },
      readNotifications: () => Promise.resolve(),
    });
    const panel = await openPanel(view);
    const { client } = view.world;
    // A frame says the inbox changed: the panel's page is asked again, and the answer waits.
    void client.invalidateQueries({ queryKey: keys.notifications(IDS.workspace) });
    await settle();
    await person().click(within(panel).getByRole('button', { name: 'Mark read' }));
    await settle();
    // The stale answer lands now, still saying unread.
    held.answer?.(page([told(8, 'mention')]));
    await settle();
    const cached = client.getQueryData<NotificationPage>(
      keys.notificationsPanel(IDS.workspace, 'all'),
    );
    expect(cached?.data[0]?.readAt).not.toBeNull();
    view.unmount();
  });

  test('a thread gathering more replies than the server takes at once is read in several requests', async () => {
    const reads: ReadNotificationsRequest[] = [];
    const many = Array.from({ length: 130 }, (_, n) => told(100 + n, 'mention'));
    const view = await visit(
      {
        notifications: () => Promise.resolve(page(many)),
        readNotifications: (input) => {
          reads.push(input);
          return Promise.resolve();
        },
      },
      '/w/acme/inbox?category=mentions',
    );
    await person().click(view.getByRole('button', { name: 'Mark all read' }));
    await settle();
    expect(reads.map((r) => ('ids' in r ? r.ids.length : 0))).toEqual([100, 30]);
    view.unmount();
  });
});
