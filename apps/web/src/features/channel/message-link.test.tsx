/**
 * A link to a message (D-149), opened in a channel: the feed around it, the message brought into
 * view, marked for a moment and focused; newer history read in below without moving the reader;
 * Jump to recent; a link nobody can follow said in one sentence; and Copy link.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { MessagePage, MessageWindow } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { mountChannel, page, settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { BOB, IDS, ME, aMessage, messageIdAt } from '../../testing/fixtures';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';
import { LANDED_MS, messageUrl } from '../messages/message-link';

installDom();

const LINKED = 50;
const linkTo = (n: number): string => `/w/acme/c/${IDS.api}?message=${messageIdAt(n)}`;

/** The window the server answers around message 50: 48 to 52, with more on both sides. */
const aWindow = (over: Partial<MessageWindow> = {}): MessageWindow => ({
  target: aMessage(LINKED, { sender: BOB }),
  data: [52, 51, 50, 49, 48].map((n) => aMessage(n, { sender: BOB })),
  olderCursor: messageIdAt(48),
  newerCursor: messageIdAt(52),
  ...over,
});

const rowOf = (n: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-message-row][data-message-id="${messageIdAt(n)}"]`);

describe('opening a link to a message', () => {
  test('reads the window around it — not the newest page — and brings it into view, marked and focused', async () => {
    const scrolled: string[] = [];
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ): void {
      scrolled.push(this.getAttribute('data-message-id') ?? '');
    });
    const asked: string[] = [];
    let newest = 0;
    const view = await mountChannel({
      path: linkTo(LINKED),
      messages: () => {
        newest += 1;
        return Promise.resolve(page([aMessage(99)]));
      },
      api: {
        messageWindow: (id) => {
          asked.push(id);
          return Promise.resolve(aWindow());
        },
      },
    });
    await settle();
    expect(asked).toEqual([messageIdAt(LINKED)]);
    expect(newest).toBe(0);
    expect(scrolled).toEqual([messageIdAt(LINKED)]);
    expect(rowOf(LINKED)?.hasAttribute('data-landed')).toBe(true);
    expectFocusOn(rowOf(LINKED));
    // The roving tab stop follows focus to it.
    expect(rowOf(LINKED)?.tabIndex).toBe(0);

    // A moment later the mark lets go; focus stays.
    act(() => {
      view.feed.timers.advance(LANDED_MS);
    });
    expect(rowOf(LINKED)?.hasAttribute('data-landed')).toBe(false);
    expectFocusOn(rowOf(LINKED));
    spy.mockRestore();
    view.unmountAll();
  });

  test('a window short of the present reads newer history in below, and offers the way back', async () => {
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const after: (string | undefined)[] = [];
    const view = await mountChannel({
      path: linkTo(LINKED),
      api: {
        messageWindow: () => Promise.resolve(aWindow()),
        messages: (_channel, query): Promise<MessagePage> => {
          after.push(query?.after);
          // Newer, oldest first, as the server answers `after`; nothing beyond.
          return Promise.resolve({
            data: [53, 54].map((n) => aMessage(n, { sender: BOB })),
            nextCursor: null,
          });
        },
      },
    });
    await settle();
    const jump = view.getByRole('button', { name: 'Jump to recent' });
    // Nothing in a window short of the present is "new": no pill, and nothing read for the person.
    expect(view.queryByRole('button', { name: /new message/ })).toBeNull();

    // The reader is at the window's bottom when it comes into view; what is read in makes it taller.
    expect(view.metrics.top).toBe(view.metrics.scrollHeight - view.metrics.clientHeight);
    // The scroll the reader made to get there, which a browser reports.
    fireEvent.scroll(view.scroller());
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight += 400;
    act(() => {
      view.feed.sentinelVisible();
    });
    await settle();
    expect(after).toContain(messageIdAt(52));
    expect(rowOf(54)).not.toBeNull();
    // Read in below on purpose: the reader is not carried to the new bottom.
    expect(view.metrics.assigned).toEqual([]);
    // The window now reaches the present.
    expect(view.queryByRole('button', { name: 'Jump to recent' })).toBeNull();
    expect(jump.isConnected).toBe(false);
    spy.mockRestore();
    view.unmountAll();
  });

  test('Jump to recent opens the channel at the present, in place of the link', async () => {
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const view = await mountChannel({
      path: linkTo(LINKED),
      messages: page([aMessage(99)]),
      api: { messageWindow: () => Promise.resolve(aWindow()) },
    });
    await settle();
    await person().click(view.getByRole('button', { name: 'Jump to recent' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
    expect(rowOf(99)).not.toBeNull();
    expect(rowOf(LINKED)).toBeNull();
    spy.mockRestore();
    view.unmountAll();
  });

  test('a message gone, or never the person’s to see, is said in one sentence and the channel opens as it is', async () => {
    const view = await mountChannel({
      path: linkTo(LINKED),
      messages: page([aMessage(99)]),
      api: {
        messageWindow: () =>
          Promise.reject(new ApiError(404, 'MESSAGE_NOT_FOUND', 'Message not found.')),
      },
    });
    await settle();
    expect(
      view.getByText("That message no longer exists, or you can't see it.").getAttribute('role'),
    ).toBe('status');
    expect(rowOf(99)).not.toBeNull();
    view.unmountAll();
  });

  test('a message of another channel is not opened here', async () => {
    const view = await mountChannel({
      path: linkTo(LINKED),
      messages: page([aMessage(99)]),
      api: {
        messageWindow: () =>
          Promise.resolve(aWindow({ target: aMessage(LINKED, { channelId: IDS.deploys }) })),
      },
    });
    await settle();
    expect(view.getByText("That message no longer exists, or you can't see it.")).toBeDefined();
    expect(rowOf(99)).not.toBeNull();
    view.unmountAll();
  });
});

describe('copying a link to a message', () => {
  test('is the whole address, from the page’s origin', () => {
    expect(messageUrl('https://chat.example.com', 'acme', aMessage(3))).toBe(
      `https://chat.example.com/w/acme/c/${IDS.api}?message=${messageIdAt(3)}`,
    );
  });

  test('is in the More menu of one’s own message, and says it was copied', async () => {
    const copied: string[] = [];
    const view = await mountChannel({
      messages: page([aMessage(1, { sender: ME })]),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    const row = rowOf(1);
    if (row === null) throw new Error('no row');
    await person().click(within(row).getByRole('button', { name: 'More' }));
    await person().click(view.getByRole('menuitem', { name: 'Copy link' }));
    await settle();
    expect(copied).toEqual([new URL(linkTo(1), window.location.origin).href]);
    expect(view.getByText('Link copied')).toBeDefined();
    view.unmountAll();
  });

  test('a clipboard that refuses is said, not ignored', async () => {
    const view = await mountChannel({
      messages: page([aMessage(1, { sender: ME })]),
      copy: () => Promise.reject(new Error('denied')),
    });
    const row = rowOf(1);
    if (row === null) throw new Error('no row');
    await person().click(within(row).getByRole('button', { name: 'More' }));
    await person().click(view.getByRole('menuitem', { name: 'Copy link' }));
    await settle();
    expect(view.getByText("Couldn't copy. Select the text and copy it yourself.")).toBeDefined();
    view.unmountAll();
  });
});
