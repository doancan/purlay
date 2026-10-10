/**
 * The sidebar as a person meets it: through the real frame, over an API the test writes.
 * Every state of every section, every action, and the keyboard.
 */
import { describe, expect, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type { Message } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { OverlayProvider } from '../shell/overlay';
import { JumpField } from './jump-field';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WORKSPACE,
  aChannel,
  aMessage,
  aSession,
  aSignedInApi,
  someChannels,
  someMembers,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { Toaster } from '../../ui/toast';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** An element a query was sure to find, or a failure that says so. */
const some = <T extends HTMLElement>(node: T | null | undefined): T => {
  if (node === null || node === undefined) throw new Error('the element was not there');
  return node;
};

const GENERIC = 'Something went wrong on our side. Try again in a moment.';

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Api = aSignedInApi(), path = `/w/acme/c/${IDS.api}`): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path, api },
  );
  await settle();
  return view;
};

const here = (view: View): string => view.world.history.stack.at(-1) ?? '';
const links = (view: View, scope: string): string[] =>
  view
    .getAllByRole('navigation', { name: scope })
    .flatMap((nav) => [...nav.querySelectorAll('a')])
    .map((a) => a.textContent.trim());

describe('the channels section', () => {
  test('lists the channels the person is in, # and name, and not the one they could join', async () => {
    const view = await open();
    expect(links(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
    expect(view.queryByText('browse')).toBeNull();
  });

  test('is ordered by activity: the channel somebody wrote in last is first', async () => {
    const channels = someChannels().map((c) =>
      c.id === IDS.incidents ? { ...c, lastMessageAt: '2026-09-09T09:00:00.000Z' } : c,
    );
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    expect(links(view, 'Channels')[0]).toBe('incidents');
  });

  test('the channel you are in is the current page, and nothing else is', async () => {
    const view = await open();
    // The sidebar's own links: the header's Feed tab is current too, and is not its business.
    const current = within(view.getByRole('complementary', { name: 'Workspace' }))
      .getAllByRole('link')
      .filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent.trim())).toEqual(['api']);
    expect(current[0]?.getAttribute('href')).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('an unread channel is announced as unread, and a mention carries its count', async () => {
    const channels = someChannels().map((c) =>
      c.id === IDS.deploys
        ? { ...c, state: { lastReadMessageId: null, unreadCount: 4, unreadMentionCount: 2 } }
        : c,
    );
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    const row = view.getByRole('link', { name: /deploys/ });
    expect(row.textContent).toContain('unread');
    expect(row.className).toContain('font-semibold');
    expect(view.getByRole('img', { name: '2 unread mentions' })).toBeDefined();
    expect(view.getByRole('link', { name: 'incidents' }).textContent).not.toContain('unread');
  });

  test('a private channel is drawn with the lock', async () => {
    const channels = [
      aChannel(IDS.api, 'api'),
      aChannel(IDS.deploys, 'secret', { type: 'private' }),
    ];
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    expect(links(view, 'Channels')).toEqual(['api', 'secret']);
  });

  test('loads as skeleton rows, not a spinner and not a flash of "no channels"', async () => {
    const view = await open(aSignedInApi({ channels: () => new Promise(() => undefined) }));
    expect(view.getAllByRole('status').some((s) => s.textContent === 'Loading channels')).toBe(
      true,
    );
    expect(view.queryByText('No channels yet')).toBeNull();
  });

  test('a failure says so, and Retry asks again', async () => {
    let fail = true;
    const view = await open(
      aSignedInApi({
        channels: () =>
          fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'broke'))
            : Promise.resolve(someChannels()),
      }),
      '/w/acme/questions',
    );
    expect(
      view.getAllByRole('alert').some((a) => a.textContent.includes("Couldn't load channels")),
    ).toBe(true);
    fail = false;
    await person().click(some(view.getAllByRole('button', { name: 'Retry' })[0]));
    await settle();
    expect(links(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
  });

  test('in no channel at all, the section says what to do next, and offers it', async () => {
    const view = await open(
      aSignedInApi({ channels: () => Promise.resolve([]) }),
      '/w/acme/questions',
    );
    expect(view.getByText('No channels yet')).toBeDefined();
    const buttons = view.getAllByRole('button', { name: 'New channel' });
    expect(buttons).toHaveLength(2);
    await person().click(some(buttons.at(-1)));
    expect(view.getByRole('dialog', { name: 'New channel' })).toBeDefined();
  });
});

describe('the open questions', () => {
  const root = (n: number): Message =>
    aMessage(n, {
      thread: { replyCount: 1, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
    });

  test('are the first thing in the list, and say how many there are', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1), root(2), root(3)], nextCursor: null }),
      }),
    );
    const first = view.getAllByRole('link')[0];
    expect(first?.textContent).toContain('Open questions');
    expect(first?.textContent).toContain('3');
    expect(first?.getAttribute('href')).toBe('/w/acme/questions');
  });

  test('keep their height however long the list of channels below them is: a flex item that may shrink is squashed to a line', async () => {
    const view = await open(aSignedInApi());
    expect(view.getAllByRole('link')[0]?.className).toContain('shrink-0');
  });

  test('say nothing while they load or when there are none — never a wrong zero', async () => {
    const quiet = await open(aSignedInApi());
    expect(quiet.getAllByRole('link')[0]?.textContent.trim()).toBe('Open questions');
    quiet.unmount();
    const waiting = await open(aSignedInApi({ unresolved: () => new Promise(() => undefined) }));
    expect(waiting.getAllByRole('link')[0]?.textContent.trim()).toBe('Open questions');
  });

  test('say "99+" when there are more pages than that is willing to count', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1)], nextCursor: aMessage(1).id }),
      }),
    );
    expect(view.getAllByRole('link')[0]?.textContent).toContain('99+');
  });

  test('is the current page on its own screen', async () => {
    const view = await open(aSignedInApi(), '/w/acme/questions');
    expect(view.getAllByRole('link')[0]?.getAttribute('aria-current')).toBe('page');
  });

  test('change the moment a thread is resolved: the count follows the cache', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1), root(2)], nextCursor: null }),
      }),
    );
    expect(view.getAllByRole('link')[0]?.textContent).toContain('2');
    await act(async () => {
      view.world.client.setQueryData(keys.unresolved(IDS.workspace), {
        pageParams: [undefined],
        pages: [{ data: [root(1)], nextCursor: null }],
      });
      await Promise.resolve();
    });
    await settle();
    expect(view.getAllByRole('link')[0]?.textContent).toContain('1');
    expect(view.getAllByRole('link')[0]?.textContent).not.toContain('2');
  });
});

describe('the people section', () => {
  const direct = (id: string, peer: typeof ALICE, over = {}): ReturnType<typeof aChannel> =>
    aChannel(id, null, { type: 'direct_message', peer, ...over });

  test('lists everyone, once, and labels the person themselves', async () => {
    const view = await open();
    const section = some(view.getByRole('heading', { name: 'People' }).closest('section'));
    // What is read aloud: the avatars are decorative, so what they say is not part of a name.
    const spoken = (li: Element): string => {
      const copy = li.cloneNode(true) as Element;
      for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
      return copy.textContent.trim();
    };
    expect([...section.querySelectorAll('li')].map(spoken)).toEqual([
      'Alice',
      'Bob',
      'Dogancan you',
    ]);
  });

  test('each person has an avatar with their initials, hidden from a screen reader, and none has a presence dot', async () => {
    const view = await open();
    const section = some(view.getByRole('heading', { name: 'People' }).closest('section'));
    const avatars = [...section.querySelectorAll('li [aria-hidden="true"].size-avatar-sm')];
    expect(avatars.map((avatar) => avatar.textContent)).toEqual(['AL', 'BO', 'DO']);
    expect(section.querySelector('.size-dot')).toBeNull();
  });

  test('somebody with a conversation is a link to it, named for them, once', async () => {
    const channels = [
      ...someChannels(),
      direct(IDS.dm, ALICE, { lastMessageAt: '2026-09-09T09:00:00.000Z' }),
    ];
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    const alice = view.getByRole('link', { name: 'Alice' });
    expect(alice.getAttribute('href')).toBe(`/w/acme/c/${IDS.dm}`);
    expect(view.getAllByText('Alice')).toHaveLength(1);
    // A conversation is under People, not under Channels.
    expect(links(view, 'Channels')).toEqual(['api', 'deploys', 'incidents']);
  });

  test('a note to self is named for the person, and says "you"', async () => {
    const channels = [...someChannels(), direct(IDS.dm, ME)];
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    expect(view.getByRole('link', { name: 'Dogancan you' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.dm}`,
    );
  });

  test('an unread conversation is bold and carries its count', async () => {
    const channels = [
      ...someChannels(),
      direct(IDS.dm, BOB, {
        state: { lastReadMessageId: null, unreadCount: 3, unreadMentionCount: 3 },
      }),
    ];
    const view = await open(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    expect(view.getByRole('link', { name: /Bob/ }).className).toContain('font-semibold');
    expect(view.getByRole('img', { name: '3 unread mentions' })).toBeDefined();
  });

  test('somebody without one opens it on click, and lands in it', async () => {
    const asked: string[] = [];
    const api = aSignedInApi({
      openDirectMessage: (_workspace, userId) => {
        asked.push(userId);
        return Promise.resolve(direct(IDS.dm, BOB));
      },
    });
    const view = await open(api);
    await person().click(view.getByRole('button', { name: 'Bob' }));
    await settle();
    expect(asked).toEqual([IDS.bob]);
    expect(here(view)).toBe(`/w/acme/c/${IDS.dm}`);
  });

  test('a conversation that cannot be opened says so and stays where it was', async () => {
    const api = aSignedInApi({
      openDirectMessage: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')),
    });
    const view = await open(api);
    await person().click(view.getByRole('button', { name: 'Bob' }));
    await settle();
    expect(
      view.getAllByRole('status').some((s) => s.textContent.includes('could not be opened')),
    ).toBe(true);
    expect(here(view)).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('loads as skeleton rows; fails with Retry', async () => {
    const waiting = await open(aSignedInApi({ members: () => new Promise(() => undefined) }));
    expect(waiting.getAllByRole('status').some((s) => s.textContent === 'Loading')).toBe(true);
    waiting.unmount();

    let fail = true;
    const view = await open(
      aSignedInApi({
        members: () =>
          fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'x'))
            : Promise.resolve(someMembers()),
      }),
    );
    expect(view.getAllByRole('alert').length).toBeGreaterThan(0);
    fail = false;
    await person().click(some(view.getAllByRole('button', { name: 'Retry' })[0]));
    await settle();
    expect(view.getByRole('button', { name: 'Bob' })).toBeDefined();
  });
});

describe('the workspace menu', () => {
  const two = (): ReturnType<typeof aSession> => ({
    ...aSession(),
    memberships: [
      ...aSession().memberships,
      {
        workspace: {
          ...WORKSPACE,
          id: '00000000-0000-4000-8000-0000000000a2',
          name: 'side-project',
          slug: 'side',
        },
        role: 'member',
        joinedAt: '2026-09-09T08:00:00.000Z',
      },
    ],
  });

  test('names the workspace, lists the others, and marks the one you are in', async () => {
    const view = await open(aSignedInApi({ me: () => Promise.resolve(two()) }));
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    const items = view.getAllByRole('menuitem').map((i) => i.textContent);
    expect(items).toEqual(['acme-eng', 'side-project', 'Sign out']);
    expect(view.getByText('Signed in as Dogancan')).toBeDefined();
  });

  test('choosing another goes to it', async () => {
    const view = await open(
      aSignedInApi({
        me: () => Promise.resolve(two()),
        channels: () => Promise.resolve([]),
      }),
    );
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'side-project' }));
    expect(here(view)).toBe('/w/side');
  });

  test('signing out asks, forgets the page, and goes to sign-in without a way Back', async () => {
    let signedOut = false;
    const api = aSignedInApi({
      me: () =>
        signedOut
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no'))
          : Promise.resolve(aSession()),
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    });
    const view = await open(api);
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(signedOut).toBe(true);
    expect(here(view)).toBe('/sign-in');
    expect(view.world.history.stack).toEqual(['/sign-in']);
  });
});

describe('signing out, when it goes wrong or goes right', () => {
  test('a refused sign-out says so, in words that fit the cause, and leaves the person where they were', async () => {
    const api = aSignedInApi({
      signOut: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
    });
    const view = await open(api);
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(
      view.getByText("Couldn't sign you out. Check your connection and try again."),
    ).toBeDefined();
    expect(here(view)).not.toBe('/sign-in');
  });

  test('forgets what the browser kept for this person — drafts, the last channel, unsent messages — and keeps the theme', async () => {
    const view = await open(aSignedInApi({ signOut: () => Promise.resolve() }));
    const { storage } = view.world;
    storage.setItem('purlay.draft.c1', 'half a thought');
    storage.setItem('purlay.draft.c1.t9', 'half a reply');
    storage.setItem('purlay.lastChannel.w1', 'c1');
    storage.setItem('purlay.pending.u1', '[]');
    storage.setItem('purlay.theme', 'dark');
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(Object.keys(storage.data)).toEqual(['purlay.theme']);
  });

  test('a refused sign-out forgets nothing: the person is still signed in with their drafts', async () => {
    const api = aSignedInApi({ signOut: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')) });
    const view = await open(api);
    view.world.storage.setItem('purlay.draft.c1', 'keep me');
    await person().click(view.getByRole('button', { name: 'Switch workspace' }));
    await person().click(view.getByRole('menuitem', { name: 'Sign out' }));
    await settle();
    expect(view.world.storage.data['purlay.draft.c1']).toBe('keep me');
  });
});

describe('the jump field', () => {
  test('is a button that says the key, and a click opens the command palette', async () => {
    const view = await open();
    const sidebar = within(view.getByRole('complementary'));
    const jump = sidebar.getByRole('button', { name: /Jump to…/ });
    expect(jump.querySelector('kbd')?.textContent).toMatch(/^(⌘|Ctrl)K$/);
    expect(jump.getAttribute('aria-keyshortcuts')).toBe('Control+K Meta+K');
    expect(view.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    await person().click(jump);
    await settle();
    expect(view.getByRole('dialog', { name: 'Command palette' })).toBeDefined();
  });

  test('is not drawn where nothing renders the palette, rather than drawn and dead', async () => {
    const alone = await renderApp(<JumpField />);
    expect(alone.queryByRole('button')).toBeNull();
    alone.unmount();
    const inside = await renderApp(
      <OverlayProvider>
        <JumpField />
      </OverlayProvider>,
    );
    expect(inside.getByRole('button', { name: /Jump to…/ })).toBeDefined();
  });
});

describe('the footer', () => {
  test('says who you are, and the key that jumps', async () => {
    const view = await open();
    const footer = view.getByRole('contentinfo');
    expect(footer.textContent).toContain('Dogancan');
    expect(footer.querySelector('[aria-hidden="true"].size-avatar-sm')?.textContent).toBe('DO');
    // The hint moved to the jump field above; the footer no longer carries it.
    expect(footer.querySelector('kbd')).toBeNull();
    expect(view.getByRole('button', { name: 'Theme' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Language' })).toBeDefined();
  });
});

describe('a new channel', () => {
  const asked = (): { calls: unknown[]; api: Api } => {
    const calls: unknown[] = [];
    const api = aSignedInApi({
      createChannel: (_ws, input) => {
        calls.push(input);
        return Promise.resolve(aChannel(IDS.browse, input.name));
      },
    });
    return { calls, api };
  };

  const fill = async (view: View, name: string, topic = ''): Promise<void> => {
    await person().click(view.getByRole('button', { name: 'New channel' }));
    await person().type(view.getByLabelText('Name'), name);
    if (topic !== '') await person().type(view.getByLabelText('Topic'), topic);
  };

  test('is made from a name and a topic, then opened', async () => {
    const { calls, api } = asked();
    const view = await open(api);
    await fill(view, 'platform', 'Infra chatter');
    await person().click(view.getByRole('button', { name: 'Create channel' }));
    await settle();
    expect(calls).toEqual([{ name: 'platform', topic: 'Infra chatter' }]);
    expect(here(view)).toBe(`/w/acme/c/${IDS.browse}`);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('the topic is optional and is not sent empty', async () => {
    const { calls, api } = asked();
    const view = await open(api);
    await fill(view, 'platform');
    await person().click(view.getByRole('button', { name: 'Create channel' }));
    await settle();
    expect(calls).toEqual([{ name: 'platform' }]);
  });

  test('a name that breaks the rule is refused before the server hears, in the field', async () => {
    const { calls, api } = asked();
    const view = await open(api);
    await fill(view, 'Not Valid!');
    await person().click(view.getByRole('button', { name: 'Create channel' }));
    expect(
      view.getAllByRole('alert').some((a) => a.textContent.includes('Use lowercase letters')),
    ).toBe(true);
    expect(calls).toEqual([]);
  });

  test.each([
    ['one that is taken', new ApiError(409, 'CHANNEL_NAME_TAKEN', 'x'), 'already exists'],
    [
      'one the server refuses',
      new ApiError(400, 'VALIDATION_FAILED', 'x'),
      'Use lowercase letters',
    ],
    ['a failure it cannot explain', new ApiError(500, 'INTERNAL', 'x'), 'was not created'],
    [
      'something that is not even an API error',
      new Error('boom') as unknown as ApiError,
      'was not created',
    ],
  ])('%s is said in words, and what was typed stays', async (_why, failure, words) => {
    const view = await open(aSignedInApi({ createChannel: () => Promise.reject(failure) }));
    await fill(view, 'platform');
    await person().click(view.getByRole('button', { name: 'Create channel' }));
    await settle();
    expect(view.getAllByRole('alert').some((a) => a.textContent.includes(words))).toBe(true);
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('platform');
  });

  test('Escape closes it, forgets what was typed, and gives focus back to the button', async () => {
    const view = await open();
    const opener = view.getByRole('button', { name: 'New channel' });
    await fill(view, 'draft');
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement === opener).toBe(true);
    });
    await person().click(opener);
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('');
  });

  test('Cancel closes it too, and it passes the accessibility audit', async () => {
    const view = await open();
    await person().click(view.getByRole('button', { name: 'New channel' }));
    await expectNoAxeViolations(view.getByRole('dialog'));
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(view.queryByRole('dialog')).toBeNull();
    });
  });
});

describe('browsing channels', () => {
  const browse = async (api: Api = aSignedInApi()): Promise<View> => {
    const view = await open(api);
    await person().click(view.getByRole('button', { name: 'Browse channels' }));
    return view;
  };

  test('lists what the person could join, and nothing they are already in', async () => {
    const view = await browse();
    const dialog = view.getByRole('dialog', { name: 'Browse channels' });
    expect(dialog.textContent).toContain('browse');
    expect(dialog.textContent).not.toContain('deploys');
    await expectNoAxeViolations(dialog);
  });

  test("shows a channel's topic when it has one", async () => {
    const channels = [
      ...someChannels().slice(0, 3),
      aChannel(IDS.browse, 'browse', { state: null, topic: 'Reading list' }),
    ];
    const view = await browse(aSignedInApi({ channels: () => Promise.resolve(channels) }));
    expect(view.getByRole('dialog').textContent).toContain('Reading list');
  });

  test('joining joins, goes there, and closes', async () => {
    const joined: string[] = [];
    const view = await browse(
      aSignedInApi({
        joinChannel: (id) => {
          joined.push(id);
          return Promise.resolve(aChannel(id, 'browse'));
        },
      }),
    );
    await person().click(view.getByRole('button', { name: 'Join browse' }));
    await settle();
    expect(joined).toEqual([IDS.browse]);
    expect(here(view)).toBe(`/w/acme/c/${IDS.browse}`);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  test('a join that fails says so and does not move the person', async () => {
    const view = await browse(
      aSignedInApi({ joinChannel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'x')) }),
    );
    await person().click(view.getByRole('button', { name: 'Join browse' }));
    await settle();
    expect(view.getByText(`You could not join the channel. ${GENERIC}`)).toBeDefined();
    expect(here(view)).toBe(`/w/acme/c/${IDS.api}`);
    expect(view.getByRole('dialog')).toBeDefined();
  });

  test('with nothing to join it says so', async () => {
    const view = await browse(
      aSignedInApi({ channels: () => Promise.resolve(someChannels().slice(0, 3)) }),
    );
    expect(view.getByText('Nothing to join')).toBeDefined();
  });

  test('loads as skeleton rows', async () => {
    const view = await browse(aSignedInApi({ channels: () => new Promise(() => undefined) }));
    expect(within(view.getByRole('dialog')).getByRole('status').textContent).toBe(
      'Loading channels',
    );
  });

  test('fails with Retry, which asks again', async () => {
    let asks = 0;
    const view = await browse(
      aSignedInApi({
        channels: () => {
          asks += 1;
          return Promise.reject(new ApiError(500, 'INTERNAL', 'x'));
        },
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    expect(dialog.getByRole('alert').textContent).toContain("Couldn't load channels");
    const before = asks;
    await person().click(dialog.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(asks).toBeGreaterThan(before);
  });
});

describe('the keyboard', () => {
  test('Tab reaches the workspace, the jump field, the questions, the channels and their buttons, in that order', async () => {
    const view = await open();
    act(() => {
      view.getByRole('button', { name: 'Switch workspace' }).focus();
    });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Switch workspace');
    await person().tab();
    expect(document.activeElement?.textContent).toMatch(/^Jump to…(⌘|Ctrl)K$/);
    await person().tab();
    expect(document.activeElement?.textContent.trim().replace(/\d+$/, '')).toBe('Open questions');
    await person().tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Browse channels');
    await person().tab();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('New channel');
    await person().tab();
    expect(document.activeElement?.textContent.trim()).toBe('api');
  });

  test('the whole frame passes the accessibility audit', async () => {
    const view = await open();
    await expectNoAxeViolations(view.container);
  });
});
