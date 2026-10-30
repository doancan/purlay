/**
 * The inbox (D-106, `UX.md` §8): what each row says, where it takes the person, reading one and
 * reading all — painted first, and what a refusal leaves — and the three states.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
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
  aUser,
  messageIdAt,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { targetOf } from './why';

installDom();

const notificationId = (n: number): string =>
  `00000000-0000-4000-8000-${(0xb00 + n).toString(16).padStart(12, '0')}`;

const told = (
  n: number,
  type: Notification['type'],
  over: {
    readAt?: string | null;
    parentId?: string | null;
    rootAuthor?: string;
    excerpt?: string | null;
  } = {},
): Notification => ({
  id: notificationId(n),
  type,
  channelId: IDS.api,
  message: aMessage(n, {
    sender: n % 2 === 0 ? ALICE : BOB,
    content: `words ${String(n)}`,
    parentId: over.parentId ?? null,
  }),
  thread:
    over.parentId === undefined || over.parentId === null
      ? null
      : {
          rootId: over.parentId,
          excerpt: over.excerpt === undefined ? 'Who owns the cache?' : over.excerpt,
          authorId: over.rootAuthor ?? IDS.me,
        },
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
      [undefined, 'Bob wrote to the conversation'],
      ['tr', 'Bob konuşmaya yazdı'],
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
    expect(row?.textContent).toContain('Bob wrote to you');
    expect(row?.textContent.match(/Bob/g)).toHaveLength(1);
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
    expect(rows[0]).toContain('unread Alice mentioned you');
    expect(rows[0]).toContain('api');
    expect(rows[1]).toContain('Bob wrote to you');
    expect(rows[1]).not.toContain('unread');
    expect(rows[2]).toContain('Your question was resolved');
    expect(rows[3]).toContain('Bob wrote');
    // On a narrow window the reason is cut before the channel: the place keeps its share (a third).
    const [first] = view.getAllByRole('button', { name: /words/ });
    const place = first === undefined ? [] : within(first).getByText('api').className.split(' ');
    expect(['max-w-1/3', 'shrink-0', 'truncate'].filter((name) => !place.includes(name))).toEqual(
      [],
    );
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
    expect(view.getByText(/Alice senden bahsetti/)).toBeDefined();
    expect(view.getByRole('button', { name: 'Tümünü okundu yap' })).toBeDefined();
    view.unmount();
  });
});

describe('the sidebar', () => {
  test('has Inbox, current on the inbox', async () => {
    const view = await visit({ notifications: () => Promise.resolve(page([])) });
    // On a wide window it is the button that opens the inbox's panel (D-208).
    const link = view.getByRole('button', { name: 'Inbox' });
    expect(link.getAttribute('aria-current')).toBe('page');
    view.unmount();
  });
});

describe('categories on the page (D-208)', () => {
  test('choosing one asks the server for it, puts it in the address, and an empty one says which', async () => {
    const asked: { types?: string }[] = [];
    const view = await visit({
      notifications: (_workspaceId, at = {}) => {
        asked.push(at);
        return Promise.resolve(page(at.types === undefined ? [told(1, 'mention')] : []));
      },
    });
    const categories = within(view.getByRole('group', { name: 'Category' }));
    await person().click(categories.getByRole('button', { name: 'Direct' }));
    await settle();
    expect(asked.at(-1)?.types).toBe('direct_message');
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/inbox?category=direct');
    expect(view.getByText('No direct messages')).toBeDefined();
    // Back to All is the bare address, as it always was.
    await person().click(categories.getByRole('button', { name: 'All' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/inbox');
    expect(view.getByText('words 1')).toBeDefined();
    view.unmount();
  });
});

describe('triage', () => {
  test('Unread asks the server for what waits only, and with nothing waiting says so', async () => {
    const asked: { unreadOnly?: boolean }[] = [];
    const view = await visit({
      notifications: (_workspaceId, at = {}) => {
        asked.push(at);
        return Promise.resolve(page(at.unreadOnly === true ? [] : [told(1, 'mention')]));
      },
    });
    const unread = view.getByRole('button', { name: 'Unread' });
    expect(unread.getAttribute('aria-pressed')).toBe('false');
    await person().click(unread);
    await settle();
    expect(unread.getAttribute('aria-pressed')).toBe('true');
    expect(asked.some((at) => at.unreadOnly === true)).toBe(true);
    expect(view.getByText('All caught up')).toBeDefined();
    // The read filter's All, not the category's (D-208): each control is its own named group.
    const show = within(view.getByRole('group', { name: 'Show' }));
    await person().click(show.getByRole('button', { name: 'All' }));
    await settle();
    expect(view.getByText('words 1')).toBeDefined();
    view.unmount();
  });

  test('Mark read reads that one alone, painted at once, without leaving the inbox', async () => {
    const reads: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () => Promise.resolve(page([told(1, 'mention'), told(2, 'mention')])),
      readNotifications: (input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    const marks = view.getAllByRole('button', { name: 'Mark read' });
    expect(marks).toHaveLength(2);
    const first = marks[0];
    if (first === undefined) throw new Error('no Mark read was drawn');
    await person().click(first);
    await settle();
    expect(reads).toEqual([{ ids: [notificationId(1)] }]);
    // The other still waits, and the person is still in the inbox.
    expect(view.getAllByRole('button', { name: 'Mark read' })).toHaveLength(1);
    expect(view.world.history.stack.at(-1) ?? '/w/acme/inbox').toBe('/w/acme/inbox');
    view.unmount();
  });

  test('what was not told today is under Earlier', async () => {
    const view = await visit({
      notifications: () =>
        Promise.resolve(page([{ ...told(1, 'mention'), createdAt: '2020-01-01T08:00:00.000Z' }])),
    });
    expect(view.getByRole('heading', { name: 'Earlier' })).toBeDefined();
    expect(view.queryByRole('heading', { name: 'Today' })).toBeNull();
    view.unmount();
  });
});

describe('one thread, one row (D-162)', () => {
  const root = messageIdAt(1);
  const reply = (n: number, over: Parameters<typeof told>[2] = {}): Notification =>
    told(n, 'thread_reply', { parentId: root, ...over });
  const CAROL = aUser('carol', '00000000-0000-4000-8000-0000000000e4');

  test('a thread’s replies are one row: how many, in which thread, by whom, newest first', async () => {
    const byCarol = { ...reply(3), message: { ...reply(3).message, sender: CAROL } };
    const view = await visit({
      notifications: () =>
        Promise.resolve(page([reply(6), reply(5), told(4, 'mention'), byCarol, reply(2)])),
    });
    const rows = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('unread Alice, Bob, and 1 other replied in your thread');
    expect(rows[0]).toContain('4 new replies in “Who owns the cache?”');
    // What the newest one said, under it; the older ones are counted, not repeated.
    expect(rows[0]).toContain('words 6');
    expect(rows[0]).not.toContain('words 5');
    expect(rows[1]).toContain('Alice mentioned you');
    // One Mark read for the gathered row, one for the mention.
    expect(view.getAllByRole('button', { name: 'Mark read' })).toHaveLength(2);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a single reply names its thread too, and a thread the person only replied in is not “yours”', async () => {
    const view = await visit({
      notifications: () =>
        Promise.resolve(
          page([
            reply(4, { rootAuthor: IDS.alice }),
            told(3, 'thread_reply', {
              parentId: messageIdAt(2),
              excerpt: null,
            }),
          ]),
        ),
    });
    const rows = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
    expect(rows[0]).toContain('Alice replied in a thread you’re in');
    expect(rows[0]).toContain('In “Who owns the cache?”');
    // A root that cannot be quoted — deleted, or no words — is not named, and nothing stands in for it.
    expect(rows[1]).toContain('Bob replied in your thread');
    expect(rows[1]).not.toContain('“');
    view.unmount();
  });

  test('read, the row says how many without “new”', async () => {
    const at = '2026-09-09T09:00:00.000Z';
    const view = await visit({
      notifications: () =>
        Promise.resolve(page([reply(4, { readAt: at }), reply(3, { readAt: at })])),
    });
    const [row] = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
    expect(row).toContain('2 replies in “Who owns the cache?”');
    expect(row).not.toContain('unread');
    expect(view.queryByRole('button', { name: 'Mark read' })).toBeNull();
    view.unmount();
  });

  test('opening the row reads every reply it gathers that waits, and opens the thread', async () => {
    const asked: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () =>
        Promise.resolve(
          page([reply(6), reply(5, { readAt: '2026-09-09T09:00:00.000Z' }), reply(4)]),
        ),
      readNotifications: (input) => {
        asked.push(input);
        return new Promise<void>(() => undefined);
      },
    });
    await person().click(view.getByRole('button', { name: /words 6/ }));
    expect(asked).toEqual([{ ids: [notificationId(6), notificationId(4)] }]);
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?thread=${root}`);
    view.unmount();
  });

  test('Mark read reads every reply it gathers, painted at once', async () => {
    const reads: ReadNotificationsRequest[] = [];
    const view = await visit({
      notifications: () => Promise.resolve(page([reply(6), reply(5), reply(4)])),
      readNotifications: (input) => {
        reads.push(input);
        return Promise.resolve();
      },
    });
    expect(view.getAllByText(/unread/)).toHaveLength(1);
    await person().click(view.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(reads).toEqual([{ ids: [notificationId(6), notificationId(5), notificationId(4)] }]);
    expect(view.queryByText(/unread/)).toBeNull();
    expect(view.getByRole('button', { name: /words 6/ }).textContent).toContain(
      '3 replies in “Who owns the cache?”',
    );
    view.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await visit(
      {
        notifications: () =>
          Promise.resolve(
            page([
              reply(6),
              reply(5),
              reply(4),
              told(3, 'thread_reply', {
                parentId: messageIdAt(2),
                rootAuthor: IDS.alice,
              }),
            ]),
          ),
      },
      'tr',
    );
    const rows = view.getAllByRole('button', { name: /words/ }).map((b) => b.textContent);
    expect(rows[0]).toContain('Alice ve Bob thread’ine yanıt verdi');
    expect(rows[0]).toContain('“Who owns the cache?” thread’inde 3 yeni yanıt');
    expect(rows[1]).toContain('Bob dahil olduğun bir thread’e yanıt verdi');
    expect(rows[1]).toContain('“Who owns the cache?” thread’inde');
    view.unmount();
  });
});
