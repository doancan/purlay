/**
 * An open tab in the background (D-148), as its person meets it: a notice from the browser when a
 * conversation's mention badge goes up while they are elsewhere, saying who and where in the inbox's
 * words; one per conversation; nothing when they are in front of the page, in Deep Work, or have not
 * turned notifications on here; and a click that opens what the inbox row would.
 *
 * The browser's notices are a port of the test's own; the badges move in the cache the socket
 * writes to, as `tab-title.test.tsx` moves them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { Channel, MeResponse, Notification, QuietHours } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { keys } from '../../data/keys';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  IDS,
  ME,
  aMessage,
  aSession,
  aSignedInApi,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import type { Notice, Notifier } from '../push/notifier';
import { PUSH_OWNER_KEY } from '../push/push';

installDom();

interface FakeNotifier {
  readonly notifier: Notifier;
  readonly shown: Notice[];
  readonly closed: string[];
  asked: number;
}

const aNotifier = (permission: NotificationPermission = 'granted'): FakeNotifier => {
  const fake: FakeNotifier = {
    shown: [],
    closed: [],
    asked: 0,
    notifier: {
      permission: () => permission,
      request: () => {
        fake.asked += 1;
        return Promise.resolve(permission);
      },
      show: (notice) => {
        fake.shown.push(notice);
        return true;
      },
      close: (tag) => {
        fake.closed.push(tag);
      },
    },
  };
  return fake;
};

const waiting = (unreadMentionCount: number): Channel['state'] => ({
  lastReadMessageId: null,
  unreadCount: unreadMentionCount,
  unreadMentionCount,
});

const withBadge = (counts: Readonly<Record<string, number>>): Channel[] =>
  someChannels().map((c) => {
    const count = counts[c.id];
    return count === undefined ? c : { ...c, state: waiting(count) };
  });

const mention = (over: Partial<Notification> = {}): Notification => ({
  id: '0190a000-0000-7000-8000-00000000aaaa',
  type: 'mention',
  channelId: IDS.deploys,
  message: aMessage(7, { channelId: IDS.deploys, sender: ALICE }),
  thread: null,
  createdAt: '2026-09-09T12:00:00.000Z',
  readAt: null,
  ...over,
});

/** Where the person is: in front of the page, or somewhere else. */
let focused = false;
let realFocus: (() => boolean) | null = null;
beforeEach(() => {
  focused = false;
  realFocus = document.hasFocus.bind(document);
  document.hasFocus = (): boolean => focused;
});
afterEach(() => {
  if (realFocus !== null) document.hasFocus = realFocus;
});

const open = async ({
  notifier = aNotifier(),
  owner = IDS.me,
  inbox = [mention()],
  me = aSession(),
  path = `/w/acme/c/${IDS.api}`,
  quietHours = null,
}: {
  notifier?: FakeNotifier;
  owner?: string | null;
  inbox?: Notification[] | Promise<Notification[]>;
  me?: MeResponse;
  path?: string;
  quietHours?: QuietHours | null;
} = {}): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(<Outlet />, {
    path,
    notifier: notifier.notifier,
    api: aSignedInApi({
      me: () => Promise.resolve(me),
      channels: () => Promise.resolve(withBadge({})),
      notifications: async () => ({ data: await inbox, nextCursor: null }),
      quietHours: () => Promise.resolve({ quietHours, timeZone: 'UTC' }),
    }),
  });
  if (owner !== null) view.world.storage.setItem(PUSH_OWNER_KEY, owner);
  await settle();
  return view;
};

/** What the socket does when something new needs the person: the badge's new number. */
const rise = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  counts: Readonly<Record<string, number>>,
): Promise<void> => {
  act(() => {
    view.world.client.setQueryData(keys.channels(IDS.workspace), withBadge(counts));
  });
  await settle();
};

describe('a tab in the background', () => {
  test('is told when a badge goes up: where, and why in the inbox’s words', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown.map(({ title, body }) => ({ title, body }))).toEqual([
      { title: '#deploys', body: 'Alice mentioned you' },
    ]);
    // Asking the browser is the switch's, never the page's on load.
    expect(fake.asked).toBe(0);
    view.unmount();
  });

  test('a click opens the conversation, or the thread a reply is in', async () => {
    const fake = aNotifier();
    const root = aMessage(3, { channelId: IDS.deploys });
    const reply = mention({
      type: 'thread_reply',
      message: aMessage(8, { channelId: IDS.deploys, sender: ALICE, parentId: root.id }),
    });
    const view = await open({ notifier: fake, inbox: [reply] });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown[0]?.body).toBe('Alice replied in your thread');
    act(() => {
      fake.shown[0]?.onOpen();
    });
    expect(view.world.history.stack.at(-1)).toBe(
      `/w/acme/c/${IDS.deploys}?thread=${encodeURIComponent(root.id)}`,
    );
    view.unmount();
  });

  test('one conversation is one notice: the next replaces it, by its tag', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1 });
    await rise(view, { [IDS.deploys]: 2 });
    expect(fake.shown).toHaveLength(2);
    expect(new Set(fake.shown.map((n) => n.tag)).size).toBe(1);
    view.unmount();
  });

  test('several conversations at once are one notice, to the inbox', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1, [IDS.incidents]: 2 });
    expect(fake.shown.map((n) => n.body)).toEqual(['2 conversations need you']);
    act(() => {
      fake.shown[0]?.onOpen();
    });
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/inbox');
    view.unmount();
  });

  test('a conversation read on another device takes its notice back', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1 });
    await rise(view, { [IDS.deploys]: 0 });
    expect(fake.closed).toEqual([fake.shown[0]?.tag ?? 'none']);
    view.unmount();
  });

  for (const change of ['focus', 'read', 'quiet', 'off', 'unmount'] as const) {
    test(`a delayed inbox cannot show an obsolete notice after ${change}`, async () => {
      let release: (inbox: Notification[]) => void = () => undefined;
      const inbox = new Promise<Notification[]>((resolve) => {
        release = resolve;
      });
      const fake = aNotifier();
      const view = await open({
        notifier: fake,
        inbox,
        ...(change === 'off' ? { path: '/w/acme/settings/notifications' } : {}),
      });
      await rise(view, { [IDS.deploys]: 1 });
      expect(fake.shown).toEqual([]);
      if (change === 'focus') focused = true;
      if (change === 'read') await rise(view, { [IDS.deploys]: 0 });
      if (change === 'quiet') {
        const me = aSession();
        act(() => {
          view.world.client.setQueryData(keys.me, {
            ...me,
            memberships: me.memberships.map((m) => ({
              ...m,
              deepWorkUntil: '2026-09-09T13:00:00.000Z',
            })),
          });
        });
        await settle();
      }
      if (change === 'off') {
        await person().click(view.getByRole('button', { name: 'Turn off' }));
        await settle();
      }
      if (change === 'unmount') view.unmount();
      release([mention()]);
      await settle();
      expect(fake.shown).toEqual([]);
      if (change !== 'unmount') view.unmount();
    });
  }

  test('an unrelated badge update does not discard a pending notice that is still needed', async () => {
    let release: (inbox: Notification[]) => void = () => undefined;
    const inbox = new Promise<Notification[]>((resolve) => {
      release = resolve;
    });
    const fake = aNotifier();
    const view = await open({ notifier: fake, inbox });
    await rise(view, { [IDS.deploys]: 1 });
    act(() => {
      view.world.client.setQueryData(
        keys.channels(IDS.workspace),
        withBadge({ [IDS.deploys]: 1 }).map((channel) =>
          channel.id === IDS.api ? { ...channel, name: 'api-renamed' } : channel,
        ),
      );
    });
    await settle();
    expect(view.getByRole('link', { name: /api-renamed/ })).toBeDefined();
    release([mention()]);
    await settle();
    expect(fake.shown.map((n) => n.body)).toEqual(['Alice mentioned you']);
    view.unmount();
  });

  test('what was already waiting when the page opened is not news', async () => {
    const fake = aNotifier();
    const view = await renderApp(<Outlet />, {
      path: `/w/acme/c/${IDS.api}`,
      notifier: fake.notifier,
      api: aSignedInApi({ channels: () => Promise.resolve(withBadge({ [IDS.deploys]: 3 })) }),
    });
    view.world.storage.setItem(PUSH_OWNER_KEY, IDS.me);
    await settle();
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  test('outside the person’s quiet hours, as ever (D-234)', async () => {
    const fake = aNotifier();
    const view = await open({
      notifier: fake,
      quietHours: { from: 20 * 60, to: 7 * 60, days: [0, 1, 2, 3, 4, 5, 6] },
    });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toHaveLength(1);
    view.unmount();
  });

  test('a notice whose reason could not be read still says where', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake, inbox: [] });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown.map((n) => n.body)).toEqual(['Something here needs you']);
    view.unmount();
  });
});

describe('nothing is said', () => {
  test('to a person in front of the page: the page says it', async () => {
    focused = true;
    const fake = aNotifier();
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  test('in Deep Work', async () => {
    const me = aSession();
    const quiet: MeResponse = {
      ...me,
      memberships: me.memberships.map((m) => ({ ...m, deepWorkUntil: '2026-09-09T13:00:00.000Z' })),
    };
    const fake = aNotifier();
    const view = await open({ notifier: fake, me: quiet });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  // The test's clock reads Wednesday 2026-09-09, 12:00 UTC: a window around it, on a profile in UTC.
  const around = (): QuietHours => ({ from: 11 * 60, to: 13 * 60, days: [3] });

  test('in the person’s quiet hours (D-234)', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake, quietHours: around() });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  test('where the person has not turned notifications on here', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake, owner: null });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  test('where somebody else turned them on in this browser', async () => {
    const fake = aNotifier();
    const view = await open({ notifier: fake, owner: IDS.alice });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    view.unmount();
  });

  test('where the browser’s permission was taken back', async () => {
    const fake = aNotifier('denied');
    const view = await open({ notifier: fake });
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown).toEqual([]);
    expect(view.world.storage.getItem(PUSH_OWNER_KEY)).toBeNull();
    view.unmount();
  });

  test('for the person’s own message, which never moves their badge, nor is named as why', async () => {
    const fake = aNotifier();
    const own = mention({ message: aMessage(9, { channelId: IDS.deploys, sender: ME }) });
    const view = await open({ notifier: fake, inbox: [own] });
    // A badge that rose all the same is told without a reason that is theirs.
    await rise(view, { [IDS.deploys]: 1 });
    expect(fake.shown.map((n) => n.body)).toEqual(['Something here needs you']);
    view.unmount();
  });
});

test('an inbox request that fails still offers the conversation without claiming a reason', async () => {
  let reject: (error: Error) => void = () => undefined;
  const inbox = new Promise<Notification[]>((_resolve, refuse) => {
    reject = refuse;
  });
  const fake = aNotifier();
  const view = await open({ notifier: fake, inbox });
  await rise(view, { [IDS.deploys]: 1 });
  reject(new Error('inbox unavailable'));
  await settle();
  expect(fake.shown[0]?.body).toBe('Something here needs you');
  act(() => {
    fake.shown[0]?.onOpen();
  });
  expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}`);
  view.unmount();
});
