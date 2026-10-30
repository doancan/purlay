/**
 * A person's arrangement of their own sidebar, as they make it (D-195): folding a section, asking for only
 * what is unread, leaving out what is muted, switching a section off, and putting it all back — through the
 * real frame, over an API the test writes. What each choice leaves listed is in `preferences.test.ts`; here is
 * that the choices are offered, do what they say, are said in the button, and are kept per person and workspace.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WORKSPACE,
  aChannel,
  aSession,
  aSignedInApi,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { Toaster } from '../../ui/toast';
import { ContentPortsContext } from '../content/content-ports';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';
import type { Channel } from '@purlay/types';
import { keyFor } from './preferences';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Api, path = `/w/acme/c/${IDS.api}`): Promise<View> => {
  const view = await renderApp(<Outlet />, { path, api });
  await settle();
  return view;
};

/** `api` is open; `deploys` has messages waiting; `incidents` is read; `quiet` is muted and read. */
const channelsWithSomethingWaiting = (): Channel[] => [
  aChannel(IDS.api, 'api'),
  aChannel(IDS.deploys, 'deploys', {
    state: { lastReadMessageId: null, unreadCount: 4, unreadMentionCount: 0 },
  }),
  aChannel(IDS.incidents, 'incidents'),
  aChannel('00000000-0000-4000-8000-0000000000d1', 'quiet', { notificationLevel: 'none' }),
];

const apiWith = (channels: Channel[]): Api =>
  aSignedInApi({ channels: () => Promise.resolve(channels) });

/** What a section's rows are called, without the words only a screen reader hears or a badge's count. */
const rows = (view: View, scope: string): string[] =>
  view
    .getAllByRole('navigation', { name: scope })
    .flatMap((nav) => [...nav.querySelectorAll('a')])
    .map((a) =>
      a.textContent
        .replace(/^unread /, '')
        .replace(/\d+$/, '')
        .trim(),
    );

const options = async (view: View): Promise<void> => {
  await person().click(view.getByRole('button', { name: /^Sidebar options/ }));
  // The menu is in the deferred chunk: drawn the moment it has arrived.
  await settle();
};

const choose = async (view: View, name: string): Promise<void> => {
  await options(view);
  await person().click(view.getByRole('menuitemradio', { name }));
  await settle();
};

const heading = (view: View, name: string): HTMLElement =>
  within(view.getByRole('complementary', { name: 'Workspace' })).getByRole('button', {
    name,
  });

describe('folding a section', () => {
  test('its heading is a button that folds it, leaving what is waiting and where the person is', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents', 'quiet']);

    await person().click(heading(view, 'Channels'));
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('false');
    // `api` is open and `deploys` has messages waiting: a fold never hides what needs a look.
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys']);

    await person().click(heading(view, 'Channels'));
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('true');
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents', 'quiet']);
  });

  test('is by the keyboard too: Enter on the heading folds it', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    act(() => {
      heading(view, 'Channels').focus();
    });
    await person().keyboard('{Enter}');
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('false');
  });

  test('keeps the section’s own buttons: Browse and New channel are there folded as they are unfolded', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await person().click(heading(view, 'Channels'));
    const nav = within(view.getByRole('complementary', { name: 'Workspace' })).getByRole(
      'navigation',
      { name: 'Channels' },
    );
    for (const name of ['Browse channels', 'New channel']) {
      expect(within(nav).getByRole('button', { name })).toBeDefined();
    }
  });

  test('a fold is kept for this person and this workspace, and in no other key', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await person().click(heading(view, 'Channels'));
    const stored = Object.entries(view.world.storage.data).filter(([key]) =>
      key.startsWith('purlay.sidebar.'),
    );
    expect(stored.map(([key]) => key)).toEqual([keyFor(ME.id, WORKSPACE.id)]);
    expect(JSON.parse(stored[0]?.[1] ?? '{}')).toMatchObject({ collapsed: ['channels'] });
  });

  test('Starred folds on its own, and a channel the person starred is not left out for being muted', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(IDS.deploys, 'deploys', { starred: true, notificationLevel: 'none' }),
      aChannel(IDS.incidents, 'incidents'),
    ];
    const view = await open(apiWith(channels));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    // The menu stays open, and while it is the rest of the page is hidden from a screen reader.
    await person().keyboard('{Escape}');
    await settle();
    expect(rows(view, 'Starred')).toEqual(['deploys']);
    await person().click(heading(view, 'Starred'));
    expect(heading(view, 'Starred').getAttribute('aria-expanded')).toBe('false');
    expect(rows(view, 'Starred')).toEqual([]);
  });
});

describe('only what is unread', () => {
  test('lists what is waiting and where the person is, and says it in the button', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    const button = view.getByRole('button', { name: /^Sidebar options/ });
    expect(button.classList.contains('bg-nav-hover')).toBe(false);

    await choose(view, 'Only unread');
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys']);
    // As a whole class: `hover:bg-nav-hover`, which every button of the kind has, is not the filled state.
    expect(
      view.getByRole('button', { name: /^Sidebar options/ }).classList.contains('bg-nav-hover'),
    ).toBe(true);

    await choose(view, 'Everything');
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents', 'quiet']);
  });

  test('with nothing waiting and the person in another place, says nothing is unread and does not look failed', async () => {
    const channels = [aChannel(IDS.api, 'api'), aChannel(IDS.deploys, 'deploys')];
    // On a channel that is not in the list, so no row is the open one.
    const view = await open(apiWith(channels), '/w/acme/c/00000000-0000-4000-8000-0000000000ff');
    await choose(view, 'Only unread');
    expect(rows(view, 'Channels')).toEqual([]);
    const sidebar = within(view.getByRole('complementary', { name: 'Workspace' }));
    expect(sidebar.getByText('Nothing unread.')).toBeDefined();
    expect(sidebar.queryAllByRole('alert').length).toBe(0);
  });
});

describe('without muted channels', () => {
  test('brings back a muted channel that mentions the person', async () => {
    const channels = channelsWithSomethingWaiting().map((channel) =>
      channel.name === 'quiet'
        ? { ...channel, state: { lastReadMessageId: null, unreadCount: 1, unreadMentionCount: 1 } }
        : channel,
    );
    const view = await open(apiWith(channels));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    await person().keyboard('{Escape}');
    await settle();
    expect(rows(view, 'Channels')).toContain('quiet');
  });

  test('leaves out a muted channel nobody is waiting on', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    await person().keyboard('{Escape}');
    await settle();
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
  });

  test('leaves the menu open, so another can be set without opening it again', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    expect(view.getByRole('menu')).toBeDefined();
  });
});

describe('the order of the channels', () => {
  test('is by name until the person asks for the other, and the other moves rows by design', async () => {
    const channels = [
      aChannel(IDS.api, 'api', { lastMessageAt: '2026-09-09T08:00:00.000Z' }),
      aChannel(IDS.deploys, 'deploys', { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
      aChannel(IDS.incidents, 'incidents'),
    ];
    const view = await open(apiWith(channels));
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
    await choose(view, 'By recent activity');
    expect(rows(view, 'Channels')).toEqual(['deploys', 'api', 'incidents']);
    await choose(view, 'By name');
    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
  });
});

describe('switching a section off', () => {
  test('Conversations and People can each go, and come back, and the channels cannot be switched off', async () => {
    const view = await open(apiWith(someChannels()));
    const sidebar = within(view.getByRole('complementary', { name: 'Workspace' }));
    expect(sidebar.getByRole('heading', { name: 'People' })).toBeDefined();
    expect(sidebar.getByRole('heading', { name: 'Conversations' })).toBeDefined();

    await options(view);
    expect(view.queryAllByRole('menuitemcheckbox', { name: 'Channels' }).length).toBe(0);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'People' }));
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Conversations' }));
    await person().keyboard('{Escape}');
    await settle();
    expect(sidebar.queryAllByRole('heading', { name: 'People' }).length).toBe(0);
    expect(sidebar.queryAllByRole('heading', { name: 'Conversations' }).length).toBe(0);
    expect(sidebar.getByRole('heading', { name: 'Channels' })).toBeDefined();

    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'People' }));
    await person().keyboard('{Escape}');
    await settle();
    expect(sidebar.getByRole('heading', { name: 'People' })).toBeDefined();
  });
});

describe('putting it back', () => {
  test('Reset sidebar is offered only while something is changed, and puts everything back', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await options(view);
    expect(
      view.getByRole('menuitem', { name: 'Reset sidebar' }).getAttribute('aria-disabled'),
    ).toBe('true');
    await person().keyboard('{Escape}');

    await choose(view, 'Only unread');
    await person().click(heading(view, 'Channels'));
    await options(view);
    await person().click(view.getByRole('menuitem', { name: 'Reset sidebar' }));
    await settle();

    expect(rows(view, 'Channels')).toEqual(['api', 'deploys', 'incidents', 'quiet']);
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('true');
    expect(
      view.getByRole('button', { name: /^Sidebar options/ }).classList.contains('bg-nav-hover'),
    ).toBe(false);
  });
});

describe('what is drawn', () => {
  test('the frame passes the accessibility audit folded, with one section left out', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await person().click(heading(view, 'Channels'));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'People' }));
    await person().keyboard('{Escape}');
    await settle();
    await expectNoAxeViolations(view.container);
  });
});

const GROUP = '00000000-0000-4000-8000-0000000000d2';

const switchOff = async (view: View, section: 'People' | 'Conversations'): Promise<void> => {
  await options(view);
  await person().click(view.getByRole('menuitemcheckbox', { name: section }));
  await person().keyboard('{Escape}');
  await settle();
};

describe('a section that is off, with the person in one of its conversations', () => {
  test('People: the person whose conversation is open stays listed under the heading until the person leaves it', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE }),
    ];
    const view = await open(apiWith(channels), `/w/acme/c/${IDS.dm}`);
    await switchOff(view, 'People');
    const people = within(view.getByRole('region', { name: 'People' }));
    expect(people.getAllByRole('link').map((link) => link.textContent.trim())).toEqual([
      expect.stringContaining('Alice') as unknown as string,
    ]);
    expect(people.queryAllByText('Bob').length).toBe(0);

    await person().click(
      within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', { name: 'api' }),
    );
    await settle();
    expect(
      within(view.getByRole('complementary', { name: 'Workspace' })).queryAllByRole('heading', {
        name: 'People',
      }).length,
    ).toBe(0);
  });

  test('Conversations: the group that is open stays listed, and goes with the person', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(GROUP, null, { type: 'direct_message', peers: [ALICE, BOB], peer: null }),
    ];
    const view = await open(apiWith(channels), `/w/acme/c/${GROUP}`);
    await switchOff(view, 'Conversations');
    const section = within(view.getByRole('region', { name: 'Conversations' }));
    expect(section.getAllByRole('link')).toHaveLength(1);

    await person().click(
      within(view.getByRole('navigation', { name: 'Channels' })).getByRole('link', { name: 'api' }),
    );
    await settle();
    expect(
      within(view.getByRole('complementary', { name: 'Workspace' })).queryAllByRole('heading', {
        name: 'Conversations',
      }).length,
    ).toBe(0);
  });
});

describe('the asks together, through the lists', () => {
  test('folded, a section whose rows need no look lists none and does not say there is nothing to show', async () => {
    const channels = [aChannel(IDS.api, 'api'), aChannel(IDS.deploys, 'deploys')];
    const view = await open(apiWith(channels), '/w/acme/c/00000000-0000-4000-8000-0000000000ff');
    await person().click(heading(view, 'Channels'));
    expect(rows(view, 'Channels')).toEqual([]);
    expect(
      within(view.getByRole('complementary', { name: 'Workspace' })).queryAllByText(
        'Nothing to show with these options.',
      ).length,
    ).toBe(0);
  });

  test('folded, with the open channel muted and read, the open channel stays', async () => {
    const channels = [
      aChannel(IDS.api, 'api', { notificationLevel: 'none' }),
      aChannel(IDS.deploys, 'deploys'),
    ];
    const view = await open(apiWith(channels));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    await person().keyboard('{Escape}');
    await person().click(heading(view, 'Channels'));
    expect(rows(view, 'Channels')).toEqual(['api']);
  });

  test('only unread, People lists those with something waiting, and nobody who has no conversation', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(IDS.dm, null, {
        type: 'direct_message',
        peer: ALICE,
        state: { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 2 },
      }),
    ];
    const view = await open(apiWith(channels));
    expect(
      within(view.getByRole('complementary', { name: 'Workspace' })).getByText('Bob'),
    ).toBeDefined();
    await choose(view, 'Only unread');
    const people = within(view.getByRole('region', { name: 'People' }));
    expect(people.getByText('Alice')).toBeDefined();
    expect(people.queryAllByText('Bob').length).toBe(0);
  });

  test('without muted channels, a muted conversation and a muted person stay: only channels are left out', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(GROUP, null, {
        type: 'direct_message',
        peers: [ALICE, BOB],
        peer: null,
        notificationLevel: 'none',
      }),
      aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE, notificationLevel: 'none' }),
    ];
    const view = await open(apiWith(channels));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    await person().keyboard('{Escape}');
    await settle();
    expect(
      within(view.getByRole('region', { name: 'Conversations' })).getAllByRole('link'),
    ).toHaveLength(1);
    // Her conversation is muted, and she is still the way to it.
    expect(within(view.getByRole('region', { name: 'People' })).getByText('Alice')).toBeDefined();
  });

  test('a channel with an incident open is not folded away, muted or not', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(IDS.deploys, 'deploys', {
        notificationLevel: 'none',
        incident: { severity: 1, status: 'investigating' },
      }),
      aChannel(IDS.incidents, 'incidents'),
    ];
    const view = await open(apiWith(channels));
    await options(view);
    await person().click(view.getByRole('menuitemcheckbox', { name: 'Hide muted channels' }));
    await person().keyboard('{Escape}');
    await person().click(heading(view, 'Channels'));
    // The row says its incident after its name (D-137).
    expect(rows(view, 'Channels').map((row) => row.replace(/SEV\d.*$/, ''))).toEqual([
      'api',
      'deploys',
    ]);
  });
});

describe('the person moves to another workspace', () => {
  const two = (): ReturnType<typeof aSession> => {
    const session = aSession();
    return {
      ...session,
      memberships: [
        ...session.memberships,
        {
          workspace: {
            ...WORKSPACE,
            id: '00000000-0000-4000-8000-0000000000a2',
            name: 'side-project',
            slug: 'side',
          },
          role: 'member',
          joinedAt: '2026-09-09T08:00:00.000Z',
          deepWorkUntil: null,
        },
      ],
    };
  };

  test('each workspace keeps its own arrangement: a fold in one is not drawn in the other, and is there on return', async () => {
    const view = await open(
      aSignedInApi({
        me: () => Promise.resolve(two()),
        channels: () => Promise.resolve(channelsWithSomethingWaiting()),
      }),
    );
    await person().click(heading(view, 'Channels'));
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('false');

    await person().click(view.getByRole('button', { name: /Switch workspace/ }));
    await person().click(view.getByRole('menuitem', { name: 'side-project' }));
    await settle();
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('true');

    await person().click(view.getByRole('button', { name: /Switch workspace/ }));
    await person().click(view.getByRole('menuitem', { name: 'acme-eng' }));
    await settle();
    expect(heading(view, 'Channels').getAttribute('aria-expanded')).toBe('false');
    const keys = Object.keys(view.world.storage.data).filter((key) =>
      key.startsWith('purlay.sidebar.'),
    );
    expect(keys.sort()).toEqual([keyFor(ME.id, WORKSPACE.id)]);
  });
});

describe('the options button', () => {
  test('gives focus back to itself when the menu is closed, whichever way', async () => {
    const view = await open(apiWith(channelsWithSomethingWaiting()));
    await options(view);
    await person().keyboard('{Escape}');
    await settle();
    expectFocusOn(view.getByRole('button', { name: /^Sidebar options/ }));

    await options(view);
    await person().click(view.getByRole('menuitemradio', { name: 'Only unread' }));
    await settle();
    expectFocusOn(view.getByRole('button', { name: /^Sidebar options/ }));
  });
});

describe('folding the other sections', () => {
  test('Conversations and People fold by their headings too, each on its own', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(GROUP, null, { type: 'direct_message', peers: [ALICE, BOB], peer: null }),
      aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE }),
    ];
    const view = await open(apiWith(channels));
    await person().click(heading(view, 'Conversations'));
    expect(heading(view, 'Conversations').getAttribute('aria-expanded')).toBe('false');
    expect(heading(view, 'People').getAttribute('aria-expanded')).toBe('true');
    await person().click(heading(view, 'People'));
    expect(heading(view, 'People').getAttribute('aria-expanded')).toBe('false');
    // Folded, nothing in either is waiting or open: nothing is listed under them.
    expect(
      within(view.getByRole('region', { name: 'Conversations' })).queryAllByRole('link').length,
    ).toBe(0);
    expect(within(view.getByRole('region', { name: 'People' })).queryAllByRole('link').length).toBe(
      0,
    );
    await person().click(heading(view, 'People'));
    expect(heading(view, 'People').getAttribute('aria-expanded')).toBe('true');
  });
});

describe('Copy workspace link', () => {
  const openWithClipboard = async (copy: (text: string) => Promise<void>): Promise<View> => {
    const view = await renderApp(
      <ContentPortsContext.Provider value={{ highlight: () => Promise.resolve(null), copy }}>
        <Outlet />
        <Toaster dismissLabel="Close" />
      </ContentPortsContext.Provider>,
      { path: `/w/acme/c/${IDS.api}`, api: apiWith(channelsWithSomethingWaiting()) },
    );
    await settle();
    return view;
  };

  test('puts the workspace’s whole address on the clipboard and says so', async () => {
    const copied: string[] = [];
    const view = await openWithClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    await person().click(view.getByRole('button', { name: /Switch workspace/ }));
    await person().click(view.getByRole('menuitem', { name: 'Copy workspace link' }));
    await settle();
    expect(copied).toEqual([new URL('/w/acme', window.location.origin).href]);
    expect(view.getByText('Link copied')).toBeDefined();
  });

  test('a clipboard that refuses is said, not ignored', async () => {
    const view = await openWithClipboard(() => Promise.reject(new Error('denied')));
    await person().click(view.getByRole('button', { name: /Switch workspace/ }));
    await person().click(view.getByRole('menuitem', { name: 'Copy workspace link' }));
    await settle();
    expect(view.getByText("Couldn't copy. Select the text and copy it yourself.")).toBeDefined();
  });
});
