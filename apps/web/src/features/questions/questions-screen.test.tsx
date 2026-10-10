/**
 * The open-questions view: the questions your team has not finished answering, grouped by
 * channel, and the way back to each one's conversation (`UX.md` §4.4, §8).
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Channel, Message, MessagePage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { ApiError } from '../../data/errors';
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
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { groupByChannel } from './questions-screen';
import { lastChannel, rememberChannel } from './last-channel';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const open = {
  replyCount: 3,
  lastReplyAt: '2026-09-09T11:48:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
};
const question = (n: number, channelId: string, over: Partial<Message> = {}): Message =>
  aMessage(n, { channelId, content: `question ${String(n)}?`, thread: open, ...over });
const asPage = (data: readonly Message[], nextCursor: string | null = null): MessagePage => ({
  data: [...data].sort((a, b) => (a.id < b.id ? 1 : -1)),
  nextCursor,
});

const dm = (): Channel => aChannel(IDS.dm, null, { type: 'direct_message', peer: BOB });
const channels = (): Channel[] => [...someChannels(), dm()];

const visit = async (
  unresolved: () => Promise<MessagePage>,
  extra: { readonly channels?: Channel[] } = {},
): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, {
    path: '/w/acme/questions',
    api: aSignedInApi({
      unresolved,
      channels: () => Promise.resolve(extra.channels ?? channels()),
      members: () => Promise.resolve([]),
    }),
  });
  await settle();
  return view;
};

describe('grouping', () => {
  test('is by channel, newest question first inside a group, and the group with the newest question first', () => {
    const groups = groupByChannel([
      question(1, IDS.api),
      question(5, IDS.incidents),
      question(3, IDS.api),
      question(4, IDS.api),
    ]);
    expect(groups.map((g) => g.channelId)).toEqual([IDS.incidents, IDS.api]);
    expect(groups[1]?.questions.map((q) => q.id)).toEqual([
      messageIdAt(4),
      messageIdAt(3),
      messageIdAt(1),
    ]);
    expect(groupByChannel([])).toEqual([]);
  });
});

describe('the list', () => {
  const view = async (): ReturnType<typeof visit> =>
    await visit(() =>
      Promise.resolve(
        asPage([
          question(2, IDS.api, { sender: ALICE }),
          question(6, IDS.incidents, { sender: BOB }),
          question(4, IDS.dm, { sender: BOB, thread: { ...open, replyCount: 1 } }),
        ]),
      ),
    );

  test('has a heading per channel with its count, the channel named the way the sidebar names it', async () => {
    const screen = await view();
    expect(screen.getByRole('heading', { level: 1, name: 'Open questions' })).toBeDefined();
    // The sidebar has headings of its own (Channels, People); these are the list's.
    const headings = within(screen.getByRole('main'))
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent);
    expect(headings).toEqual([
      'incidents·1 open question',
      'bob·1 open question',
      'api·1 open question',
    ]);
    // The dot is decoration: a screen reader hears the name and the count, not a symbol.
    expect(
      within(screen.getByRole('main'))
        .getAllByRole('heading', { level: 2 })[0]
        ?.querySelector('span[aria-hidden="true"]')?.textContent,
    ).toBe('·');
    await expectNoAxeViolations(screen.container);
  });

  test('each question says who, when, what, and how many replies and when the last came', async () => {
    const screen = await view();
    const row = screen.getByText('question 2?').closest('button') as HTMLElement;
    expect(within(row).getByText('alice')).toBeDefined();
    expect(within(row).getByText(/3 replies · /)).toBeDefined();
    expect(screen.getByText(/1 reply · /)).toBeDefined();
    expect(screen.getByText(/finished answering/)).toBeDefined();
  });

  test('is a button, and it takes the person to the conversation with the thread already open', async () => {
    const screen = await view();
    await person().click(screen.getByText('question 2?').closest('button') as HTMLElement);
    expect(screen.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?thread=${messageIdAt(2)}`);
  });

  test('says "a channel you can no longer see" for one that is not in the list, and does not break', async () => {
    const screen = await visit(
      () => Promise.resolve(asPage([question(2, '00000000-0000-4000-8000-0000000000ee')])),
      {
        channels: someChannels(),
      },
    );
    expect(
      screen.getByRole('heading', { level: 2, name: 'A channel you can no longer see' }),
    ).toBeDefined();
  });

  test('speaks Turkish to a person who chose it', async () => {
    const screen = await renderApp(<Outlet />, {
      path: '/w/acme/questions',
      locale: 'tr',
      api: aSignedInApi({
        unresolved: () => Promise.resolve(asPage([question(2, IDS.api)])),
        members: () => Promise.resolve([]),
      }),
    });
    await settle();
    expect(screen.getByRole('heading', { level: 1, name: 'Açık sorular' })).toBeDefined();
    expect(screen.getByText(/3 yanıt · /)).toBeDefined();
  });
});

describe('more of them', () => {
  test('are asked for with the cursor the page gave, and the list grows', async () => {
    const asked: (string | undefined)[] = [];
    const screen = await visit((): Promise<MessagePage> => Promise.resolve(asPage([])));
    expect(screen.getByRole('heading', { name: 'Every thread is resolved' })).toBeDefined();
    screen.unmount();

    const paged = await renderApp(<Outlet />, {
      path: '/w/acme/questions',
      api: aSignedInApi({
        unresolved: (_ws, query) => {
          asked.push(query?.before);
          return Promise.resolve(
            query?.before === undefined
              ? asPage([question(8, IDS.api)], messageIdAt(8))
              : asPage([question(2, IDS.deploys)]),
          );
        },
        members: () => Promise.resolve([]),
      }),
    });
    await settle();
    expect(paged.queryByText('question 2?')).toBeNull();
    await person().click(paged.getByRole('button', { name: 'Load more questions' }));
    await settle();
    expect(asked).toEqual([undefined, messageIdAt(8)]);
    expect(paged.getByText('question 2?')).toBeDefined();
    expect(paged.queryByRole('button', { name: 'Load more questions' })).toBeNull();
  });
});

describe('its states (UX §8)', () => {
  test("loading is rows of the list's own shape, never a spinner", async () => {
    const screen = await renderApp(<Outlet />, {
      path: '/w/acme/questions',
      api: aSignedInApi({
        unresolved: () => new Promise(() => undefined),
        members: () => Promise.resolve([]),
      }),
    });
    await settle();
    expect(
      screen.getAllByRole('status').some((n) => n.textContent === 'Loading open questions'),
    ).toBe(true);
    await expectNoAxeViolations(screen.container);
  });

  test('empty is "Every thread is resolved", with the resolved glyph and what would bring one back', async () => {
    const screen = await visit(() => Promise.resolve(asPage([])));
    expect(
      screen.getByRole('heading', { level: 2, name: 'Every thread is resolved' }),
    ).toBeDefined();
    expect(screen.getByText(/the moment it has a reply and no resolution/)).toBeDefined();
    await expectNoAxeViolations(screen.container);
  });

  test('failed keeps the header and says so with a Retry that asks again', async () => {
    let attempts = 0;
    const screen = await visit(() => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve(asPage([question(2, IDS.api)]));
    });
    expect(screen.getByRole('alert').textContent).toContain("Couldn't load open questions");
    expect(screen.getByRole('heading', { level: 1, name: 'Open questions' })).toBeDefined();
    await expectNoAxeViolations(screen.container);
    await person().click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(screen.getByText('question 2?')).toBeDefined();
  });
});

describe('live', () => {
  test('a question that is resolved leaves the list, wherever it was resolved', async () => {
    let current = [question(2, IDS.api), question(3, IDS.api)];
    const screen = await visit(() => Promise.resolve(asPage(current)));
    act(() => {
      screen.world.sockets.open();
    });
    expect(screen.getByText('question 3?')).toBeDefined();
    current = [question(2, IDS.api)];
    await act(async () => {
      screen.world.sockets.deliver({
        event: 'THREAD_UPDATED',
        data: {
          channelId: IDS.api,
          messageId: messageIdAt(3),
          thread: { ...open, resolvedAt: '2026-09-09T11:50:00.000Z', resolvedBy: ALICE },
        },
        ts: 1,
      });
      await Promise.resolve();
    });
    await settle();
    expect(screen.queryByText('question 3?')).toBeNull();
    expect(screen.getByText('question 2?')).toBeDefined();
  });
});

describe('the tabs', () => {
  test('say which view this is, with the same count the sidebar shows, and Feed goes back to the last channel', async () => {
    rememberChannel(IDS.workspace, IDS.incidents);
    const screen = await visit(() =>
      Promise.resolve(asPage([question(2, IDS.api), question(3, IDS.api)])),
    );
    const views = screen.getByRole('navigation', { name: 'Channel views' });
    const current = within(views)
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Open questions2']);
    expect(within(views).getByRole('link', { name: 'Feed' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.incidents}`,
    );
  });

  test('with no remembered channel Feed goes to the first one the person is in', async () => {
    window.localStorage.removeItem(`purlay.lastChannel.${IDS.workspace}`);
    const screen = await visit(() => Promise.resolve(asPage([])));
    expect(screen.getByRole('link', { name: 'Feed' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.api}`,
    );
  });

  test("with no channels at all Feed goes to the workspace's front door, which says what to do", async () => {
    const screen = await visit(() => Promise.resolve(asPage([])), {
      channels: [aChannel(IDS.browse, 'browse', { state: null })],
    });
    expect(screen.getByRole('link', { name: 'Feed' }).getAttribute('href')).toBe('/w/acme');
  });
});

describe('the last channel', () => {
  test('is remembered per workspace, and a browser that refuses storage simply has none', () => {
    rememberChannel('w-one', 'c-one');
    expect(lastChannel('w-one')).toBe('c-one');
    expect(lastChannel('w-two')).toBeNull();
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('storage is off');
      },
    });
    expect(() => {
      rememberChannel('w-one', 'c-two');
    }).not.toThrow();
    expect(lastChannel('w-one')).toBeNull();
    if (original !== undefined) Object.defineProperty(window, 'localStorage', original);
  });
});
