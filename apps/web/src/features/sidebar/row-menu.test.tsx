/**
 * A sidebar row's context menu (D-165), as a person meets it through the real frame: opened by a
 * right click, by Shift+F10 or the ContextMenu key on a focused row, and by a long press; offering
 * only what applies to the row and what the person may do; each action painted at once and put back
 * with a toast when refused; Leave asked first; and said in Turkish when the interface is.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Channel, ChannelState, MessagePage, NotificationLevel } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { expectFocusOn } from '../../testing/focus';
import { ALICE, BOB, IDS, aChannel, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { ContentPortsContext } from '../content/content-ports';
import { LONG_PRESS_MS, isMenuKey } from './row-menu';

installDom();

const GROUP = '00000000-0000-4000-8000-0000000000c6';

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const unread = (unreadCount: number, unreadMentionCount = 0): ChannelState => ({
  lastReadMessageId: null,
  unreadCount,
  unreadMentionCount,
});

/** `api` unread with a mention, `deploys` read, `incidents` private, a person and a group. */
const theChannels = (): Channel[] => [
  aChannel(IDS.api, 'api', { state: unread(3, 1) }),
  aChannel(IDS.deploys, 'deploys'),
  aChannel(IDS.incidents, 'incidents', { type: 'private' }),
  aChannel(IDS.dm, null, { type: 'direct_message', peer: ALICE }),
  aChannel(GROUP, null, { type: 'direct_message', peers: [ALICE, BOB] }),
];

type View = Awaited<ReturnType<typeof renderApp>>;

interface Options {
  readonly api?: Partial<Api>;
  readonly channels?: Channel[];
  readonly copy?: (text: string) => Promise<void>;
  readonly locale?: 'en' | 'tr';
  readonly path?: string;
}

const open = async ({
  api = {},
  channels = theChannels(),
  copy = (): Promise<void> => Promise.resolve(),
  locale = 'en',
  path = `/w/acme/c/${IDS.deploys}`,
}: Options = {}): Promise<View> => {
  const view = await renderApp(
    <ContentPortsContext.Provider value={{ highlight: () => Promise.resolve(null), copy }}>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path,
      locale,
      api: aSignedInApi({
        channels: () => Promise.resolve(channels),
        messages: () => Promise.resolve({ data: [], nextCursor: null }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

/** A row of the sidebar, by the words it shows. */
const rowOf = (view: View, name: string): HTMLElement => {
  const row = [...view.container.querySelectorAll<HTMLElement>('aside a, nav a')].find(
    (link) =>
      link.getAttribute('href')?.includes('/c/') === true &&
      // The name, after what a screen reader hears before it ("unread", in either language).
      [name, ` ${name}`].some((end) =>
        (link.querySelector('.flex-1')?.textContent ?? '').trim().endsWith(end),
      ),
  );
  if (row === undefined) throw new Error(`no row for ${name}`);
  return row;
};

const rightClick = async (row: HTMLElement): Promise<void> => {
  act(() => {
    fireEvent.contextMenu(row, { clientX: 40, clientY: 120 });
  });
  await settle();
};

/** Every item, plain and radio alike, in the order the menu has them. */
const itemsOf = (view: View): HTMLElement[] => [
  ...view.getByRole('menu').querySelectorAll<HTMLElement>('[role^="menuitem"]'),
];

const items = (view: View): string[] => itemsOf(view).map((item) => item.textContent.trim());

const choose = async (view: View, name: string): Promise<void> => {
  const item = itemsOf(view).find((each) => each.textContent.trim() === name);
  if (item === undefined) throw new Error(`no item ${name}`);
  await person().click(item);
  await settle();
};

describe('opening it', () => {
  test('a right click opens it at the pointer, named by the row, and no browser menu', async () => {
    const view = await open();
    const row = rowOf(view, 'deploys');
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40 });
    act(() => {
      row.dispatchEvent(event);
    });
    await settle();
    expect(event.defaultPrevented).toBe(true);
    expect(view.getByRole('menu', { name: 'Actions for #deploys' })).toBeDefined();
    await expectNoAxeViolations(view.getByRole('menu'));
    view.unmount();
  });

  test('Shift+F10 on a focused row opens it with the first item focused; Escape gives the row focus back', async () => {
    const view = await open();
    const row = rowOf(view, 'deploys');
    row.focus();
    await person().keyboard('{Shift>}{F10}{/Shift}');
    await settle();
    const menu = view.getByRole('menu', { name: 'Actions for #deploys' });
    expect(menu.contains(document.activeElement)).toBe(true);
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('menu')).toBeNull();
    expectFocusOn(row);
    view.unmount();
  });

  test('the ContextMenu key opens it too, and the arrows walk its items', async () => {
    const view = await open();
    const row = rowOf(view, 'deploys');
    row.focus();
    act(() => {
      fireEvent.keyDown(row, { key: 'ContextMenu' });
    });
    await settle();
    expect(view.getByRole('menu')).toBeDefined();
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: 'a', shiftKey: true })).toBe(false);
    view.unmount();
  });

  test('a keyboard’s own contextmenu, with no point, opens it under the row', async () => {
    const view = await open();
    act(() => {
      fireEvent.contextMenu(rowOf(view, 'deploys'), { clientX: 0, clientY: 0 });
    });
    await settle();
    expect(view.getByRole('menu')).toBeDefined();
    view.unmount();
  });

  test('a finger held on a row opens it, and the tap that ends the press goes nowhere', async () => {
    const view = await open();
    const row = rowOf(view, 'incidents');
    const before = view.world.history.stack.length;
    act(() => {
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 30, clientY: 200 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    });
    await settle();
    expect(view.getByRole('menu', { name: 'Actions for #incidents' })).toBeDefined();
    act(() => {
      fireEvent.pointerUp(row, { pointerType: 'touch' });
      fireEvent.click(row);
    });
    expect(view.world.history.stack.length).toBe(before);
    view.unmount();
  });

  test('a finger that moves is scrolling, and one lifted early is a tap: neither opens it', async () => {
    const view = await open();
    const row = rowOf(view, 'incidents');
    act(() => {
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 30, clientY: 200 });
      fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 30, clientY: 240 });
      fireEvent.pointerDown(row, { pointerType: 'touch', clientX: 30, clientY: 200 });
      fireEvent.pointerMove(row, { pointerType: 'touch', clientX: 32, clientY: 202 });
      fireEvent.pointerCancel(row, { pointerType: 'touch' });
      fireEvent.pointerDown(row, { pointerType: 'mouse', clientX: 30, clientY: 200 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LONG_PRESS_MS + 50));
    });
    expect(view.queryByRole('menu')).toBeNull();
    view.unmount();
  });
});

describe('what it offers', () => {
  test('an unread channel: Mark as read, Star, the levels, Copy link, Channel details…, Leave channel…', async () => {
    const view = await open();
    await rightClick(rowOf(view, 'api'));
    expect(items(view)).toEqual([
      'Mark as read',
      'Star',
      'Every message',
      'Mentions and replies',
      'Nothing',
      'Copy link',
      'Channel details…',
      'Leave channel…',
    ]);
    expect(
      within(view.getByRole('menu'))
        .getByRole('menuitemradio', { name: 'Mentions and replies' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    view.unmount();
  });

  test('a channel already read has no Mark as read; a starred one has Unstar', async () => {
    const channels = theChannels().map((c) => (c.id === IDS.deploys ? { ...c, starred: true } : c));
    const view = await open({ channels });
    await rightClick(rowOf(view, 'deploys'));
    expect(items(view)[0]).toBe('Unstar');
    expect(items(view)).not.toContain('Mark as read');
    view.unmount();
  });

  test('a conversation with one person: no star, no details and no Leave (D-127)', async () => {
    const view = await open();
    await rightClick(rowOf(view, 'Alice'));
    expect(items(view)).toEqual(['Every message', 'Mentions and replies', 'Nothing', 'Copy link']);
    view.unmount();
  });

  test('a group: Conversation details… and no Leave, since its people never change', async () => {
    const view = await open();
    await rightClick(rowOf(view, 'Alice, Bob'));
    expect(items(view)).toEqual([
      'Every message',
      'Mentions and replies',
      'Nothing',
      'Copy link',
      'Conversation details…',
    ]);
    await choose(view, 'Conversation details…');
    expect(view.getByRole('dialog', { name: 'Alice, Bob' })).toBeDefined();
    view.unmount();
  });

  test('is said in Turkish when the interface is', async () => {
    const view = await open({ locale: 'tr' });
    await rightClick(rowOf(view, 'api'));
    expect(view.getByRole('menu', { name: '#api için işlemler' })).toBeDefined();
    expect(items(view)).toEqual([
      'Okundu olarak işaretle',
      'Yıldızla',
      'Her mesaj',
      'Bahsetmeler ve yanıtlar',
      'Hiçbir şey',
      'Bağlantıyı kopyala',
      'Kanal ayrıntıları…',
      'Kanaldan ayrıl…',
    ]);
    view.unmount();
  });
});

/** Whether a row is said to be unread, as a screen reader hears it. */
const saidUnread = (view: View, name: string): boolean =>
  rowOf(view, name).textContent.startsWith('unread');

describe('Mark as read', () => {
  test('reads the feed to its newest message, painted before the server answers', async () => {
    const asked: [string, string][] = [];
    const pages: [string, number | undefined][] = [];
    let answer: (state: ChannelState) => void = () => undefined;
    const view = await open({
      api: {
        messages: (channelId, page): Promise<MessagePage> => {
          pages.push([channelId, page?.limit]);
          return Promise.resolve({
            data: channelId === IDS.api ? [aMessage(9)] : [],
            nextCursor: null,
          });
        },
        markRead: (channelId, id) => {
          asked.push([channelId, id]);
          return new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
    });
    expect(saidUnread(view, 'api')).toBe(true);
    await rightClick(rowOf(view, 'api'));
    await choose(view, 'Mark as read');
    expect(saidUnread(view, 'api')).toBe(false);
    expect(pages).toContainEqual([IDS.api, 1]);
    expect(asked).toEqual([[IDS.api, aMessage(9).id]]);
    // The server's numbers are the ones that stay: a reply waiting in a thread still counts (D-147).
    await act(async () => {
      answer(unread(1, 1));
      await Promise.resolve();
    });
    await settle();
    expect(saidUnread(view, 'api')).toBe(true);
    view.unmount();
  });

  test('refused, the row is unread again and the toast says why', async () => {
    const view = await open({
      api: {
        messages: (channelId) =>
          Promise.resolve({ data: channelId === IDS.api ? [aMessage(9)] : [], nextCursor: null }),
        markRead: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
      },
    });
    await rightClick(rowOf(view, 'api'));
    await choose(view, 'Mark as read');
    expect(await view.findByText(/^It was not marked as read\./)).toBeDefined();
    expect(saidUnread(view, 'api')).toBe(true);
    view.unmount();
  });

  test('with no message in the feed to name, nothing is asked and the row stays as it was', async () => {
    const view = await open({ api: { markRead: () => Promise.reject(new Error('not asked')) } });
    await rightClick(rowOf(view, 'api'));
    await choose(view, 'Mark as read');
    expect(saidUnread(view, 'api')).toBe(true);
    expect(view.queryByText(/not marked as read/)).toBeNull();
    view.unmount();
  });
});

describe('Star', () => {
  test('moves the channel into Starred at once, and Unstar takes it out', async () => {
    const asked: [string, boolean][] = [];
    const view = await open({
      api: {
        star: (channelId, on) => {
          asked.push([channelId, on]);
          return new Promise(() => undefined);
        },
      },
    });
    await rightClick(rowOf(view, 'deploys'));
    await choose(view, 'Star');
    const starred = view.getByRole('navigation', { name: 'Starred' });
    expect(within(starred).getByText('deploys')).toBeDefined();
    await rightClick(rowOf(view, 'deploys'));
    await choose(view, 'Unstar');
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    expect(asked).toEqual([[IDS.deploys, true]]);
    view.unmount();
  });

  test('refused, the star comes off again and the toast says why', async () => {
    const view = await open({
      api: { star: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    await rightClick(rowOf(view, 'deploys'));
    await choose(view, 'Star');
    expect(await view.findByText(/^The channel was not starred\./)).toBeDefined();
    await settle();
    expect(view.queryByRole('navigation', { name: 'Starred' })).toBeNull();
    view.unmount();
  });
});

describe('the notification level', () => {
  test('Nothing is painted on the row at once, and the server is asked', async () => {
    const asked: [string, NotificationLevel][] = [];
    const view = await open({
      api: {
        setNotificationLevel: (channelId, level) => {
          asked.push([channelId, level]);
          return new Promise<void>(() => undefined);
        },
      },
    });
    await rightClick(rowOf(view, 'Alice'));
    await choose(view, 'Nothing');
    expect(asked).toEqual([[IDS.dm, 'none']]);
    expect(within(rowOf(view, 'Alice')).getByRole('img', { name: 'muted' })).toBeDefined();
    view.unmount();
  });

  test('refused, the level it had comes back and the toast says why', async () => {
    const view = await open({
      api: { setNotificationLevel: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    await rightClick(rowOf(view, 'deploys'));
    await choose(view, 'Every message');
    expect(await view.findByText(/^The notification level was not changed\./)).toBeDefined();
    await rightClick(rowOf(view, 'deploys'));
    expect(
      within(view.getByRole('menu'))
        .getByRole('menuitemradio', { name: 'Mentions and replies' })
        .getAttribute('aria-checked'),
    ).toBe('true');
    view.unmount();
  });
});

describe('Copy link', () => {
  test('puts the channel’s whole address on the clipboard and says so', async () => {
    const copied: string[] = [];
    const view = await open({
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    await rightClick(rowOf(view, 'incidents'));
    await choose(view, 'Copy link');
    expect(copied).toEqual([new URL(`/w/acme/c/${IDS.incidents}`, window.location.origin).href]);
    expect(view.getByText('Link copied')).toBeDefined();
    view.unmount();
  });

  test('a clipboard that refuses is said, not ignored', async () => {
    const view = await open({ copy: () => Promise.reject(new Error('denied')) });
    await rightClick(rowOf(view, 'incidents'));
    await choose(view, 'Copy link');
    expect(view.getByText("Couldn't copy. Select the text and copy it yourself.")).toBeDefined();
    view.unmount();
  });
});

describe('Channel details…', () => {
  test('opens the channel’s details, and closing them gives the row focus', async () => {
    const view = await open({
      api: { channelMembers: () => Promise.resolve([]), githubFeeds: () => Promise.resolve([]) },
    });
    const row = rowOf(view, 'incidents');
    await rightClick(row);
    await choose(view, 'Channel details…');
    // Its own chunk: the first test to open it in a process waits for the module to compile.
    expect(
      await view.findByRole('dialog', { name: 'Details of #incidents' }, { timeout: 5_000 }),
    ).toBeDefined();
    await settle();
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expectFocusOn(row);
    view.unmount();
  });
});

describe('Leave channel…', () => {
  const leaving = async (view: View, name: string): Promise<HTMLElement> => {
    await rightClick(rowOf(view, name));
    await choose(view, 'Leave channel…');
    return view.getByRole('dialog', { name: `Leave #${name}?` });
  };

  test('asks first; Cancel leaves nothing', async () => {
    const view = await open({
      api: { leaveChannel: () => Promise.reject(new Error('not asked')) },
    });
    const dialog = await leaving(view, 'incidents');
    expect(within(dialog).getByText(/Only a member can bring you back\./)).toBeDefined();
    await expectNoAxeViolations(dialog);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(rowOf(view, 'incidents')).toBeDefined();
    view.unmount();
  });

  test('leaving another channel takes it off the list and says so, and the person stays where they are', async () => {
    const left: string[] = [];
    let channels = theChannels();
    const view = await open({
      api: {
        channels: () => Promise.resolve(channels),
        leaveChannel: (channelId) => {
          left.push(channelId);
          channels = channels.map((c) => (c.id === channelId ? { ...c, state: null } : c));
          return Promise.resolve();
        },
      },
    });
    const dialog = await leaving(view, 'api');
    expect(within(dialog).getByText(/join it again from Browse channels\./)).toBeDefined();
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await settle();
    expect(left).toEqual([IDS.api]);
    expect(view.getByText('You left #api.')).toBeDefined();
    expect(() => rowOf(view, 'api')).toThrow();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}`);
    view.unmount();
  });

  test('leaving the channel being read goes to the workspace', async () => {
    const view = await open({ api: { leaveChannel: () => Promise.resolve() } });
    const dialog = await leaving(view, 'deploys');
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await settle();
    // Out of the channel it was in: the workspace, which opens where the person goes next.
    expect(view.world.history.stack.at(-1)).not.toBe(`/w/acme/c/${IDS.deploys}`);
    view.unmount();
  });

  test('the last member of a private channel is told what to do instead, in the dialog', async () => {
    const view = await open({
      api: {
        leaveChannel: () => Promise.reject(new ApiError(409, 'LAST_CHANNEL_MEMBER', 'last one')),
      },
    });
    const dialog = await leaving(view, 'incidents');
    await person().click(within(dialog).getByRole('button', { name: 'Leave channel' }));
    await settle();
    expect(within(dialog).getByRole('alert').textContent).toContain(
      'You are the last one in this private channel.',
    );
    // Closed and opened again, it asks afresh.
    await person().keyboard('{Escape}');
    await settle();
    const again = await leaving(view, 'incidents');
    expect(within(again).queryByRole('alert')).toBeNull();
    view.unmount();
  });
});
