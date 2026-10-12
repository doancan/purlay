/**
 * The inbox (D-106, `UX.md` §8): what each row says, where it takes the person, and the three
 * states.
 */
import { describe, expect, test } from 'bun:test';
import type { Notification, NotificationPage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import type { Api } from '../../data/api';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, aMessage, aSignedInApi, messageIdAt } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { targetOf } from './inbox-screen';

installDom();

const notificationId = (n: number): string =>
  `00000000-0000-4000-8000-${(0xb00 + n).toString(16).padStart(12, '0')}`;

const told = (
  n: number,
  type: Notification['type'],
  over: { readAt?: string | null; parentId?: string | null } = {},
): Notification => ({
  id: notificationId(n),
  type,
  channelId: IDS.api,
  message: aMessage(n, {
    sender: n % 2 === 0 ? ALICE : BOB,
    content: `words ${String(n)}`,
    parentId: over.parentId ?? null,
  }),
  createdAt: '2026-09-09T08:00:00.000Z',
  readAt: over.readAt ?? null,
});

const page = (
  data: readonly Notification[],
  nextCursor: string | null = null,
): NotificationPage => ({
  data: [...data],
  nextCursor,
});

/** The screen and where its toasts are drawn, as the app mounts them. */
const withToasts = (
  <>
    <Outlet />
    <Toaster dismissLabel="Close" />
  </>
);

const visit = async (api: Partial<Api>, locale?: 'tr'): ReturnType<typeof renderApp> => {
  const view = await renderApp(withToasts, {
    path: '/w/acme/inbox',
    api: aSignedInApi(api),
    ...(locale === undefined ? {} : { locale }),
  });
  await settle();
  return view;
};

describe('where a notification takes the person', () => {
  test('a reply to its thread, a resolution to the thread it closed, anything else to its channel', () => {
    const at = (n: Notification): string => targetOf('acme', n);
    expect(at(told(1, 'mention'))).toBe(`/w/acme/c/${IDS.api}`);
    expect(at(told(2, 'direct_message'))).toBe(`/w/acme/c/${IDS.api}`);
    expect(at(told(3, 'thread_reply', { parentId: messageIdAt(1) }))).toBe(
      `/w/acme/c/${IDS.api}?thread=${messageIdAt(1)}`,
    );
    expect(at(told(4, 'mention', { parentId: messageIdAt(1) }))).toBe(
      `/w/acme/c/${IDS.api}?thread=${messageIdAt(1)}`,
    );
    expect(at(told(5, 'thread_resolved'))).toBe(`/w/acme/c/${IDS.api}?thread=${messageIdAt(5)}`);
  });
});

describe('the list', () => {
  test('each row says why, who, where and what, and which are unread', async () => {
    const view = await visit({
      notifications: () =>
        Promise.resolve(
          page([
            told(4, 'mention'),
            told(3, 'direct_message', { readAt: '2026-09-09T09:00:00.000Z' }),
            told(2, 'thread_resolved'),
          ]),
        ),
    });
    expect(view.getByRole('heading', { level: 1, name: 'Inbox' })).toBeDefined();
    const rows = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
    expect(rows[0]).toContain('unread alice mentioned you');
    expect(rows[0]).toContain('api');
    expect(rows[1]).toContain('bob wrote to you');
    expect(rows[1]).not.toContain('unread');
    expect(rows[2]).toContain('Your question was resolved');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('opening one goes to it', async () => {
    const view = await visit({
      notifications: () => Promise.resolve(page([told(4, 'mention')])),
    });
    await person().click(view.getByRole('button', { name: /words 4/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('more is a page away', async () => {
    const asked: (string | undefined)[] = [];
    const view = await visit({
      notifications: (_workspace, at) => {
        asked.push(at?.before);
        return Promise.resolve(
          at?.before === undefined
            ? page([told(4, 'mention')], notificationId(4))
            : page([told(2, 'mention')]),
        );
      },
    });
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked).toEqual([undefined, notificationId(4)]);
    expect(view.getByRole('button', { name: /words 2/ })).toBeDefined();
    view.unmount();
  });
});

describe('the states', () => {
  test('loading, then empty, said in words', async () => {
    let answer: (value: NotificationPage) => void = () => undefined;
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/inbox',
      api: aSignedInApi({
        notifications: () =>
          new Promise<NotificationPage>((resolve) => {
            answer = resolve;
          }),
      }),
    });
    await settle();
    expect(
      view.getAllByRole('status').some((node) => node.textContent === 'Loading your inbox'),
    ).toBe(true);
    answer(page([]));
    await settle();
    expect(view.getByRole('heading', { name: 'Nothing needs you' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('failed says so, with a Retry that asks again', async () => {
    let attempts = 0;
    const view = await visit({
      notifications: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(page([told(4, 'mention')]));
      },
    });
    expect(view.getByRole('alert').textContent).toContain("Couldn't load your inbox");
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByRole('button', { name: /words 4/ })).toBeDefined();
    view.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await visit(
      { notifications: () => Promise.resolve(page([told(4, 'mention')])) },
      'tr',
    );
    expect(view.getByRole('heading', { level: 1, name: 'Gelen kutusu' })).toBeDefined();
    expect(view.getByText(/alice senden bahsetti/)).toBeDefined();
    view.unmount();
  });
});

describe('the sidebar', () => {
  test('has Inbox, current on the inbox', async () => {
    const view = await visit({ notifications: () => Promise.resolve(page([])) });
    const link = view.getByRole('link', { name: 'Inbox' });
    expect(link.getAttribute('aria-current')).toBe('page');
    view.unmount();
  });
});
