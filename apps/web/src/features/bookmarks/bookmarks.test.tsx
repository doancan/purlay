/**
 * A channel's bookmarks as a person meets them (D-218): the row under the header, adding one (a bare
 * domain read as https, the site's name when none is given, a refusal said in the form), removing one
 * at once with Undo, nothing to change for someone not in the channel and no row when there is nothing
 * to show them, and the frame that reads them again. Through the real channel screen.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { AddBookmarkRequest, BookmarkList, ChannelBookmark } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { ALICE, IDS, someChannels } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { bookmarkTitle, bookmarkUrl } from './bookmark-input';

installDom();

let counter = 0;
const aBookmark = (over: Partial<ChannelBookmark> = {}): ChannelBookmark => {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    channelId: IDS.api,
    url: 'https://docs.example.com/runbook',
    title: 'Runbook',
    addedBy: ALICE,
    addedAt: '2026-10-31T09:00:00.000Z',
    ...over,
  };
};

/** A server whose bookmarks are what was added and removed. */
const aServer = (
  kept: ChannelBookmark[] = [],
): {
  kept: ChannelBookmark[];
  readonly added: AddBookmarkRequest[];
  readonly removed: string[];
  readonly bookmarks: () => Promise<BookmarkList>;
  readonly addBookmark: (channelId: string, input: AddBookmarkRequest) => Promise<ChannelBookmark>;
  readonly removeBookmark: (channelId: string, id: string) => Promise<void>;
} => {
  const server = {
    kept,
    added: [] as AddBookmarkRequest[],
    removed: [] as string[],
    bookmarks: (): Promise<BookmarkList> => Promise.resolve([...server.kept]),
    addBookmark: (_: string, input: AddBookmarkRequest): Promise<ChannelBookmark> => {
      server.added.push(input);
      const bookmark = aBookmark(input);
      server.kept = [...server.kept, bookmark];
      return Promise.resolve(bookmark);
    },
    removeBookmark: (_: string, id: string): Promise<void> => {
      server.removed.push(id);
      server.kept = server.kept.filter((each) => each.id !== id);
      return Promise.resolve();
    },
  };
  return server;
};

const barOf = (view: ChannelView): HTMLElement =>
  view.getByRole('navigation', { name: 'Bookmarks' });

const addThrough = async (view: ChannelView, address: string, name = ''): Promise<void> => {
  await person().click(within(barOf(view)).getByRole('button', { name: 'Add a bookmark' }));
  const dialog = within(await view.findByRole('dialog', { name: 'Add a bookmark' }));
  await person().type(dialog.getByRole('textbox', { name: 'Address' }), address);
  if (name !== '') await person().type(dialog.getByRole('textbox', { name: /^Name/ }), name);
  await person().click(dialog.getByRole('button', { name: 'Add a bookmark' }));
  await settle();
};

describe('what a person types for a bookmark', () => {
  test('a bare domain is read as https; a web address is kept as typed', () => {
    expect(bookmarkUrl('docs.example.com/a')).toBe('https://docs.example.com/a');
    expect(bookmarkUrl('  http://grafana.local:3000/d/1 ')).toBe('http://grafana.local:3000/d/1');
    expect(bookmarkUrl('HTTPS://Example.com')).toBe('HTTPS://Example.com');
  });

  test('anything a browser would not open as a page is not an address', () => {
    for (const typed of [
      '',
      '   ',
      'javascript:alert(1)',
      'mailto:a@b.c',
      'ftp://x.y',
      'a b.com',
    ]) {
      expect(bookmarkUrl(typed)).toBeNull();
    }
  });

  test('the name given, or the site’s own without www, cut to what a chip holds', () => {
    expect(bookmarkTitle('  Runbook ', 'https://x.example')).toBe('Runbook');
    expect(bookmarkTitle('', 'https://www.example.com/path')).toBe('example.com');
    expect(bookmarkTitle('ş'.repeat(100), 'https://x.example')).toHaveLength(80);
    // An emoji is two code units: one that would be cut in half is left out whole.
    expect(bookmarkTitle(`${'a'.repeat(79)}🚀`, 'https://x.example')).toBe('a'.repeat(79));
  });
});

describe('a channel’s bookmarks', () => {
  test('are shown under the header as links that open in a new tab, without the referrer', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: aServer([aBookmark(), aBookmark({ title: 'Dashboard', url: 'https://grafana.local' })]),
    });
    await settle();
    const links = within(barOf(view)).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Runbook', 'Dashboard']);
    expect(links[0]?.getAttribute('href')).toBe('https://docs.example.com/runbook');
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(links[0]?.getAttribute('rel')).toBe('noopener noreferrer');
    await expectNoAxeViolations(barOf(view));
    view.unmountAll();
  });

  test('a member adds one: a bare domain as https and the site’s name, shown once the server has it', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([]), api: server });
    await settle();
    await addThrough(view, 'docs.example.com/runbook');
    expect(server.added).toEqual([
      { url: 'https://docs.example.com/runbook', title: 'docs.example.com' },
    ]);
    expect(within(barOf(view)).getByRole('link', { name: 'docs.example.com' })).toBeDefined();
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmountAll();
  });

  test('an address that is not the web is refused in the form, and nothing is asked', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([]), api: server });
    await settle();
    await addThrough(view, 'javascript:alert(1)');
    expect(server.added).toEqual([]);
    expect(view.getByText('Use a web address, like https://docs.example.com.')).toBeDefined();
    view.unmountAll();
  });

  test('a full channel is said in the form, which keeps what was typed', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...aServer(),
        addBookmark: () => Promise.reject(new ApiError(409, 'BOOKMARKS_LIMIT', 'full')),
      },
    });
    await settle();
    await addThrough(view, 'https://x.example', 'X');
    const dialog = within(view.getByRole('dialog', { name: 'Add a bookmark' }));
    expect(dialog.getByRole('alert').textContent).toContain('at most 20 bookmarks');
    expect(dialog.getByRole<HTMLInputElement>('textbox', { name: 'Address' }).value).toBe(
      'https://x.example',
    );
    view.unmountAll();
  });

  test('an address the server will not take is said under the address', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...aServer(),
        addBookmark: () => Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'url')),
      },
    });
    await settle();
    await addThrough(view, 'https://x.example');
    const dialog = within(view.getByRole('dialog', { name: 'Add a bookmark' }));
    expect(dialog.queryByRole('alert')).toBeNull();
    expect(dialog.getByText('Use a web address, like https://docs.example.com.')).toBeDefined();
    view.unmountAll();
  });

  test('any other failure to add is said in the form, with what went wrong', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...aServer(),
        addBookmark: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
      },
    });
    await settle();
    await addThrough(view, 'https://x.example');
    const dialog = within(view.getByRole('dialog', { name: 'Add a bookmark' }));
    expect(dialog.getByRole('alert').textContent).toStartWith('The bookmark was not added. ');
    view.unmountAll();
  });

  test('Cancel closes the form unsent, and it opens again empty', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([]), api: server });
    await settle();
    await person().click(within(barOf(view)).getByRole('button', { name: 'Add a bookmark' }));
    const typed = within(await view.findByRole('dialog', { name: 'Add a bookmark' }));
    await person().type(typed.getByRole('textbox', { name: 'Address' }), 'docs.example.com');
    await person().click(typed.getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(server.added).toEqual([]);

    await person().click(within(barOf(view)).getByRole('button', { name: 'Add a bookmark' }));
    const again = within(await view.findByRole('dialog', { name: 'Add a bookmark' }));
    expect(again.getByRole<HTMLInputElement>('textbox', { name: 'Address' }).value).toBe('');
    view.unmountAll();
  });

  test('one added beside those already there is shown after them', async () => {
    const view = await mountChannel({ messages: page([]), api: aServer([aBookmark()]) });
    await settle();
    await addThrough(view, 'https://grafana.local', 'Dashboard');
    const links = within(barOf(view)).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['Runbook', 'Dashboard']);
    view.unmountAll();
  });

  test('an Undo the server refuses says so, and the bookmark stays removed', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...aServer([aBookmark()]),
        addBookmark: () => Promise.reject(new ApiError(409, 'BOOKMARKS_LIMIT', 'full')),
      },
    });
    await settle();
    await person().click(
      within(barOf(view)).getByRole('button', { name: 'Remove the bookmark Runbook' }),
    );
    await person().click(await view.findByRole('button', { name: 'Undo' }));
    expect(await view.findByText(/The bookmark was not added\./)).toBeDefined();
    expect(within(barOf(view)).queryByRole('link')).toBeNull();
    view.unmountAll();
  });

  test('removing one someone else already removed says nothing: it is gone, as asked', async () => {
    const server = aServer([aBookmark()]);
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...server,
        removeBookmark: () => {
          server.kept = [];
          return Promise.reject(new ApiError(404, 'BOOKMARK_NOT_FOUND', 'gone'));
        },
      },
    });
    await settle();
    await person().click(
      within(barOf(view)).getByRole('button', { name: 'Remove the bookmark Runbook' }),
    );
    await settle();
    expect(view.queryByText(/The bookmark was not removed\./)).toBeNull();
    expect(within(barOf(view)).queryByRole('link')).toBeNull();
    view.unmountAll();
  });

  test('removing one takes it off at once, and Undo adds the same address and name back', async () => {
    const kept = aBookmark();
    const server = aServer([kept]);
    const view = await mountChannel({ messages: page([]), api: server });
    await settle();
    await person().click(
      within(barOf(view)).getByRole('button', { name: 'Remove the bookmark Runbook' }),
    );
    expect(within(barOf(view)).queryByRole('link')).toBeNull();
    expect(server.removed).toEqual([kept.id]);
    await person().click(await view.findByRole('button', { name: 'Undo' }));
    await settle();
    expect(server.added).toEqual([{ url: kept.url, title: kept.title }]);
    expect(within(barOf(view)).getByRole('link', { name: 'Runbook' })).toBeDefined();
    view.unmountAll();
  });

  test('a refused removal puts it back as the server has it, and says so', async () => {
    const kept = aBookmark();
    const view = await mountChannel({
      messages: page([]),
      api: {
        ...aServer([kept]),
        removeBookmark: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
      },
    });
    await settle();
    await person().click(
      within(barOf(view)).getByRole('button', { name: 'Remove the bookmark Runbook' }),
    );
    expect(await view.findByText(/The bookmark was not removed\./)).toBeDefined();
    await settle();
    expect(within(barOf(view)).getByRole('link', { name: 'Runbook' })).toBeDefined();
    view.unmountAll();
  });

  test('someone not in the channel reads them with nothing to change, and sees no row when there are none', async () => {
    const shown = await mountChannel({
      channelId: IDS.browse,
      channels: someChannels(),
      messages: page([]),
      api: { bookmarks: () => Promise.resolve([aBookmark({ channelId: IDS.browse })]) },
    });
    await settle();
    expect(within(barOf(shown)).getByRole('link', { name: 'Runbook' })).toBeDefined();
    expect(within(barOf(shown)).queryByRole('button')).toBeNull();
    shown.unmountAll();

    const empty = await mountChannel({
      channelId: IDS.browse,
      channels: someChannels(),
      messages: page([]),
    });
    await settle();
    expect(empty.queryByRole('navigation', { name: 'Bookmarks' })).toBeNull();
    empty.unmountAll();
  });

  test('another member’s change, heard on the socket, is read again', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([]), api: server });
    act(() => {
      view.world.sockets.open();
    });
    await settle();
    server.kept = [aBookmark({ title: 'Added elsewhere' })];
    await act(async () => {
      view.world.sockets.deliver({
        event: 'BOOKMARKS_UPDATED',
        data: { channelId: IDS.api },
        ts: 1,
      });
      await Promise.resolve();
    });
    await settle();
    expect(within(barOf(view)).getByRole('link', { name: 'Added elsewhere' })).toBeDefined();
    view.unmountAll();
  });
});
