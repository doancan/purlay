/**
 * The rail as a person meets it: through the real frame, over an API the test writes (D-110).
 * Every entry is a place that already existed; what is checked is that each is reachable, named,
 * says where you are, and carries only the signal it is owed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { MeResponse, Message } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import {
  IDS,
  aChannel,
  aMessage,
  aSession,
  aSignedInApi,
  someChannels,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
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

type View = Awaited<ReturnType<typeof renderApp>>;

const open = async (api: Api = aSignedInApi(), path = `/w/acme/c/${IDS.api}`): Promise<View> => {
  const view = await renderApp(<Outlet />, { path, api });
  await settle();
  return view;
};

const places = (view: View): HTMLElement => view.getByRole('navigation', { name: 'Places' });

const root = (n: number): Message =>
  aMessage(n, {
    thread: { replyCount: 1, lastReplyAt: null, resolvedAt: null, resolvedBy: null },
  });

describe('the rail', () => {
  test('holds the five places, each named, and Settings at its foot (D-146) — not the workspace (D-206)', async () => {
    const view = await open();
    const rail = within(places(view));
    // The workspace is drawn once, at the head of the sidebar; the rail is the places.
    expect(rail.queryByRole('button', { name: /Switch workspace/ })).toBeNull();
    expect(
      rail.getAllByRole('link').map((link) => link.textContent.trim().replace(/\d+$/, '')),
    ).toEqual(['Channels', 'Open questions', 'Search', 'Saved', 'Settings']);
    // The inbox opens its panel (D-208): a button, between Channels and Open questions.
    expect(rail.getAllByRole('button').map((button) => button.textContent.trim())).toEqual([
      'Inbox',
    ]);
    // A link to a page, not a menu of its own.
    expect(rail.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  test('Settings opens the person’s Profile page, and is the current page while any settings page is', async () => {
    const view = await open();
    const settings = within(places(view)).getByRole('link', { name: 'Settings' });
    expect(settings.getAttribute('href')).toBe('/w/acme/settings');
    expect(settings.hasAttribute('aria-current')).toBe(false);
    await person().click(settings);
    expect(await view.findByRole('heading', { level: 1, name: 'Profile' })).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/settings');
    const marked = (): string[] =>
      within(places(view))
        .getAllByRole('link')
        .filter((link) => link.hasAttribute('aria-current'))
        .map((link) => link.textContent.trim().replace(/\d+$/, ''));
    expect(marked()).toEqual(['Settings']);
    await person().click(view.getByRole('link', { name: 'Preferences' }));
    await view.findByRole('heading', { level: 1, name: 'Preferences' });
    expect(marked()).toEqual(['Settings']);
  });

  test('the workspace’s one door is its mark and name, outside the rail, and opens the switcher', async () => {
    const view = await open();
    const doors = view.getAllByRole('button', { name: /Switch workspace/ });
    expect(doors).toHaveLength(1);
    const [door] = doors as [HTMLElement];
    expect(places(view).contains(door)).toBe(false);
    // The name is seen and heard first; the initials beside it are a picture, hidden from a screen reader.
    expect(door.querySelector('[aria-hidden="true"]')?.textContent).toBe('AE');
    expect(door.textContent).toContain('acme-eng');
    await person().click(door);
    expect(view.getByRole('menuitemradio', { name: 'acme-eng' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    const items = view.getAllByRole('menuitem').map((item) => item.textContent);
    // Signing out is the person's, in the account menu, not the workspace's (D-124).
    expect(items).not.toContain('Sign out');
  });

  test.each([
    [`/w/acme/c/${IDS.api}`, 'Channels'],
    ['/w/acme/inbox', 'Inbox'],
    ['/w/acme/questions', 'Open questions'],
    ['/w/acme/search', 'Search'],
    ['/w/acme/saved', 'Saved'],
  ])('on %s, %s is the current page and nothing else is', async (path, current) => {
    const view = await open(
      aSignedInApi({ saved: () => Promise.resolve({ data: [], nextCursor: null }) }),
      path,
    );
    // Links and the inbox's button alike: whichever says where the person is.
    const marked = [...places(view).querySelectorAll('[aria-current]')].map((link) =>
      link.textContent.trim().replace(/\d+$/, ''),
    );
    expect(marked).toEqual([current]);
  });

  test('Channels marks a section, not a page: the open channel’s row is the page', async () => {
    const view = await open();
    expect(
      within(places(view)).getByRole('link', { name: 'Channels' }).getAttribute('aria-current'),
    ).toBe('true');
    // In the navigation; the channel's own Feed tab is a page of the channel, and says so there.
    const pages = [places(view), view.getByRole('complementary', { name: 'Workspace' })]
      .flatMap((region) => [...region.querySelectorAll('[aria-current="page"]')])
      .map((link) => link.textContent.trim());
    expect(pages).toEqual(['api']);
  });

  test('Channels goes to the workspace, which opens the channel you were last in', async () => {
    const view = await open(aSignedInApi(), '/w/acme/inbox');
    expect(within(places(view)).getByRole('link', { name: 'Channels' }).getAttribute('href')).toBe(
      '/w/acme',
    );
  });

  test('Channels takes you back to the channel you were last in, not the first in the list', async () => {
    const view = await open(aSignedInApi(), `/w/acme/c/${IDS.deploys}`);
    await person().click(within(places(view)).getByRole('link', { name: 'Saved' }));
    await settle();
    await person().click(within(places(view)).getByRole('link', { name: 'Channels' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}`);
  });
});

describe('the inbox', () => {
  test('carries a dot, said in words, while something needs you', async () => {
    const [first, ...rest] = someChannels();
    if (first === undefined) throw new Error('no channels');
    const waiting = { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 2 };
    const view = await open(
      aSignedInApi({
        channels: () => Promise.resolve([{ ...first, state: waiting }, ...rest]),
      }),
    );
    expect(within(places(view)).getByRole('button', { name: /Inbox/ }).textContent).toContain(
      'unread',
    );
  });

  test('in Deep Work it carries nothing, as the badges draw nothing (D-15)', async () => {
    const [first, ...rest] = someChannels();
    if (first === undefined) throw new Error('no channels');
    const waiting = { lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 2 };
    const me = aSession();
    const quiet: MeResponse = {
      ...me,
      memberships: me.memberships.map((m) => ({ ...m, deepWorkUntil: '2026-09-09T13:00:00.000Z' })),
    };
    const view = await open(
      aSignedInApi({
        me: () => Promise.resolve(quiet),
        channels: () => Promise.resolve([{ ...first, state: waiting }, ...rest]),
      }),
    );
    // The same channels, out of Deep Work, carry the dot: the test above.
    expect(within(places(view)).getByRole('button', { name: /Inbox/ }).textContent.trim()).toBe(
      'Inbox',
    );
  });

  test('carries nothing when nothing does — unread messages alone are not a reason', async () => {
    const view = await open(
      aSignedInApi({
        channels: () =>
          Promise.resolve([
            aChannel(IDS.api, 'api', {
              state: { lastReadMessageId: null, unreadCount: 5, unreadMentionCount: 0 },
            }),
          ]),
      }),
    );
    expect(within(places(view)).getByRole('button', { name: /Inbox/ }).textContent.trim()).toBe(
      'Inbox',
    );
  });
});

describe('the open questions', () => {
  test('say how many there are', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1), root(2), root(3)], nextCursor: null }),
      }),
    );
    const link = within(places(view)).getByRole('link', { name: /Open questions/ });
    expect(link.textContent).toContain('3');
    expect(link.getAttribute('href')).toBe('/w/acme/questions');
  });

  test('say nothing while they load or when there are none — never a wrong zero', async () => {
    const quiet = await open(aSignedInApi());
    expect(
      within(places(quiet))
        .getByRole('link', { name: /Open questions/ })
        .textContent.trim(),
    ).toBe('Open questions');
    quiet.unmount();
    const waiting = await open(aSignedInApi({ unresolved: () => new Promise(() => undefined) }));
    expect(
      within(places(waiting))
        .getByRole('link', { name: /Open questions/ })
        .textContent.trim(),
    ).toBe('Open questions');
  });

  test('say "99+" when there are more pages than that is willing to count', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1)], nextCursor: aMessage(1).id }),
      }),
    );
    expect(
      within(places(view)).getByRole('link', { name: /Open questions/ }).textContent,
    ).toContain('99+');
  });

  test('change the moment a thread is resolved: the count follows the cache', async () => {
    const view = await open(
      aSignedInApi({
        unresolved: () => Promise.resolve({ data: [root(1), root(2)], nextCursor: null }),
      }),
    );
    const link = (): HTMLElement =>
      within(places(view)).getByRole('link', { name: /Open questions/ });
    expect(link().textContent).toContain('2');
    await act(async () => {
      view.world.client.setQueryData(keys.unresolved(IDS.workspace), {
        pageParams: [undefined],
        pages: [{ data: [root(1)], nextCursor: null }],
      });
      await Promise.resolve();
    });
    await settle();
    expect(link().textContent).toContain('1');
    expect(link().textContent).not.toContain('2');
  });
});

describe('the keyboard', () => {
  test('Tab runs the five places and Settings, then the sidebar from the workspace’s name', async () => {
    const view = await open();
    act(() => {
      within(places(view)).getByRole('link', { name: 'Channels' }).focus();
    });
    const names: string[] = [];
    for (let step = 0; step < 8; step++) {
      await person().tab();
      const active = document.activeElement;
      names.push(
        active?.getAttribute('aria-label') ?? active?.textContent.trim().replace(/\d+$/, '') ?? '',
      );
    }
    expect(names).toEqual([
      'Inbox',
      'Open questions',
      'Search',
      'Saved',
      'Settings',
      // The mark's two letters come first in its text and are hidden from a screen reader, which hears
      // the name and then what the button does; the card's line under the name is seen, not heard.
      expect.stringMatching(/^AEacme-eng.* Switch workspace$/) as unknown as string,
      // Beside the name, before the jump field: the person's own arrangement of the column (D-195).
      'Sidebar options',
      expect.stringMatching(/^Jump to…/) as unknown as string,
    ]);
  });

  test('the rail passes the accessibility audit', async () => {
    const view = await open();
    await expectNoAxeViolations(places(view));
  });
});
