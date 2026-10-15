/**
 * The inbox (D-106, `UX.md` §8): what each row says, where it takes the person, reading one and
 * reading all — painted first, and what a refusal leaves — and the three states.
 */
import { describe, expect, test } from 'bun:test';
import type { Notification, NotificationPage, ReadNotificationsRequest } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
import type { Api } from '../../data/api';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  aChannel,
  aMessage,
  aSignedInApi,
  messageIdAt,
} from '../../testing/fixtures';
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
  test('a message in a group says it was written to the conversation, in both languages', async () => {
    const group = aChannel(IDS.api, null, { type: 'direct_message', peers: [ALICE, BOB] });
    for (const [locale, words] of [
      [undefined, 'bob wrote to the conversation'],
      ['tr', 'bob konuşmaya yazdı'],
    ] as const) {
      const view = await visit(
        {
          channels: () => Promise.resolve([group]),
          notifications: () => Promise.resolve(page([told(3, 'direct_message')])),
        },
        locale,
      );
      const [row] = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
      expect(row).toContain(words);
      view.unmount();
    }
  });

  test('a message from one other person names them once: the conversation is them (#631)', async () => {
    const direct = aChannel(IDS.api, null, { type: 'direct_message', peer: BOB });
    const view = await visit({
      channels: () => Promise.resolve([direct]),
      notifications: () => Promise.resolve(page([told(3, 'direct_message')])),
    });
    const [row] = view.getAllByRole('button', { name: /words/ });
    expect(row?.textContent).toContain('bob wrote to you');
    expect(row?.textContent.match(/bob/g)).toHaveLength(1);
    expect(row?.textContent).not.toContain('·');
    view.unmount();
  });

  test('each row says why, who, where and what, and which are unread', async () => {
    const view = await visit({
      notifications: () =>
        Promise.resolve(
          page([
            told(4, 'mention'),
            told(3, 'direct_message', { readAt: '2026-09-09T09:00:00.000Z' }),
            told(2, 'thread_resolved'),
            told(1, 'channel_message'),
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
    expect(rows[3]).toContain('bob wrote');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('opening an unread one marks it read before the server answers, and goes to it', async () => {
    const asked: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () => Promise.resolve(page([told(4, 'mention'), told(3, 'mention')])),
      readNotifications: (input) => {
        asked.push(input);
        return new Promise<void>(() => undefined);
      },
    });
    await person().click(view.getByRole('button', { name: /words 4/ }));
    expect(asked).toEqual([{ ids: [notificationId(4)] }]);
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('opening one already read asks nothing', async () => {
    const view = await visit({
      notifications: () =>
        Promise.resolve(page([told(4, 'mention', { readAt: '2026-09-09T09:00:00.000Z' })])),
    });
    // `readNotifications` is not given: the fake fails the test if it is called.
    await person().click(view.getByRole('button', { name: /words 4/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    view.unmount();
  });

  test('Mark all read reads up to the newest on screen, painted at once', async () => {
    const asked: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () => Promise.resolve(page([told(4, 'mention'), told(3, 'mention')])),
      readNotifications: (input) => {
        asked.push(input);
        return new Promise<void>(() => undefined);
      },
    });
    expect(view.getAllByText(/unread/)).toHaveLength(2);
    await person().click(view.getByRole('button', { name: 'Mark all read' }));
    expect(asked).toEqual([{ workspaceId: IDS.workspace, before: notificationId(4) }]);
    expect(view.queryByText(/unread/)).toBeNull();
    // Nothing left to read: the button goes.
    expect(view.queryByRole('button', { name: 'Mark all read' })).toBeNull();
    view.unmount();
  });

  test('a refusal says why, and the list is asked for again', async () => {
    let asks = 0;
    const view = await visit({
      notifications: () => {
        asks += 1;
        return Promise.resolve(page([told(4, 'mention')]));
      },
      readNotifications: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    await person().click(view.getByRole('button', { name: 'Mark all read' }));
    expect(await view.findByText(/Not marked read\./)).toBeDefined();
    await settle();
    expect(asks).toBe(2);
    expect(view.getByText(/unread/)).toBeDefined();
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
    expect(view.queryByRole('button', { name: 'Mark all read' })).toBeNull();
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
    expect(view.getByRole('button', { name: 'Tümünü okundu yap' })).toBeDefined();
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
