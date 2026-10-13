/**
 * The rail as a person meets it: through the real frame, over an API the test writes (D-110).
 * Every entry is a place that already existed; what is checked is that each is reachable, named,
 * says where you are, and carries only the signal it is owed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Message } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aMessage, aSignedInApi, someChannels } from '../../testing/fixtures';
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
  test('holds the switcher and the four places, each named, and no gear: preferences are the account menu’s', async () => {
    const view = await open();
    const rail = within(places(view));
    expect(rail.getByRole('button', { name: 'Switch workspace' })).toBeDefined();
    expect(
      rail.getAllByRole('link').map((link) => link.textContent.trim().replace(/\d+$/, '')),
    ).toEqual(['Channels', 'Inbox', 'Open questions', 'Search']);
    expect(rail.queryByRole('button', { name: 'Settings' })).toBeNull();
  });

  test('the workspace tile shows its initials and opens the switcher', async () => {
    const view = await open();
    const tile = within(places(view)).getByRole('button', { name: 'Switch workspace' });
    expect(tile.textContent).toBe('AE');
    await person().click(tile);
    const items = view.getAllByRole('menuitem').map((item) => item.textContent);
    expect(items).toContain('acme-eng');
    // Signing out is the person's, in the account menu, not the workspace's (D-124).
    expect(items).not.toContain('Sign out');
  });

  test.each([
    [`/w/acme/c/${IDS.api}`, 'Channels'],
    ['/w/acme/inbox', 'Inbox'],
    ['/w/acme/questions', 'Open questions'],
    ['/w/acme/search', 'Search'],
  ])('on %s, %s is the current page and nothing else is', async (path, current) => {
    const view = await open(aSignedInApi(), path);
    const marked = within(places(view))
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent.trim().replace(/\d+$/, ''));
    expect(marked).toEqual([current]);
  });

  test('Channels goes to the workspace, which opens the channel you were last in', async () => {
    const view = await open(aSignedInApi(), '/w/acme/inbox');
    expect(within(places(view)).getByRole('link', { name: 'Channels' }).getAttribute('href')).toBe(
      '/w/acme',
    );
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
    expect(within(places(view)).getByRole('link', { name: /Inbox/ }).textContent).toContain(
      'unread',
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
    expect(within(places(view)).getByRole('link', { name: /Inbox/ }).textContent.trim()).toBe(
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
  test('Tab runs the tile and the four places, then the sidebar from the workspace’s name', async () => {
    const view = await open();
    act(() => {
      within(places(view)).getByRole('button', { name: 'Switch workspace' }).focus();
    });
    const names: string[] = [];
    for (let step = 0; step < 6; step++) {
      await person().tab();
      const active = document.activeElement;
      names.push(
        active?.getAttribute('aria-label') ?? active?.textContent.trim().replace(/\d+$/, '') ?? '',
      );
    }
    expect(names).toEqual([
      'Channels',
      'Inbox',
      'Open questions',
      'Search',
      'acme-eng',
      expect.stringMatching(/^Jump to…/) as unknown as string,
    ]);
  });

  test('the rail passes the accessibility audit', async () => {
    const view = await open();
    await expectNoAxeViolations(places(view));
  });
});
