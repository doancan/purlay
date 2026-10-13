/**
 * A channel's pins as a person meets them (D-130): Pin beside Save, painted at once and put back
 * with Retry when refused; the mark on a pinned message; nothing to press for someone not in the
 * channel; and the Pins panel beside the conversation — its states, its rows, a reply's thread,
 * letting a pin go from it — and the frame that reads it again. Through the real channel screen
 * over an API the test wrote and a socket it drives.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Message, PinList, PinnedMessage, ThreadPage } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, aMessage, messageIdAt, someChannels } from '../../testing/fixtures';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';

installDom();

const first = aMessage(1, { content: 'the runbook is here' });
const second = aMessage(2, { content: 'deploys freeze on Fridays', sender: BOB });

const aPin = (message: Message, over: Partial<PinnedMessage> = {}): PinnedMessage => ({
  message,
  pinnedBy: ALICE,
  pinnedAt: '2026-09-09T09:00:00.000Z',
  ...over,
});

/** A server whose pins are what was pinned and let go. */
const aServer = (
  pinned: PinnedMessage[] = [],
): {
  readonly pinned: PinnedMessage[];
  readonly pins: () => Promise<PinList>;
  asked: number;
} => {
  const server = {
    pinned,
    asked: 0,
    pins: (): Promise<PinList> => {
      server.asked += 1;
      return Promise.resolve([...server.pinned]);
    },
  };
  return server;
};

const pinButton = (view: ChannelView, n: number): HTMLElement => {
  const row = view.container.querySelector<HTMLElement>(
    `[role="feed"] [data-message-row][data-message-id="${messageIdAt(n)}"]`,
  );
  if (row === null) throw new Error(`no row ${String(n)}`);
  return within(row).getByRole('button', { name: /^(Pin to this channel|Unpin)$/ });
};

const rowOf = (view: ChannelView, n: number): HTMLElement => {
  const row = view.container.querySelector<HTMLElement>(
    `[role="feed"] [data-message-row][data-message-id="${messageIdAt(n)}"]`,
  );
  if (row === null) throw new Error(`no row ${String(n)}`);
  return row;
};

const toggle = (view: ChannelView): HTMLElement =>
  view.getByRole('button', { name: 'Pinned messages' });

const openPins = async (view: ChannelView): Promise<void> => {
  await person().click(toggle(view));
  await settle();
};

const panelOf = (view: ChannelView): HTMLElement =>
  view.getByRole('complementary', { name: /^Pinned/ });

describe('pinning a message', () => {
  test('is marked at once, before the server answers, and the server is asked once', async () => {
    const asked: string[] = [];
    const view = await mountChannel({
      messages: page([first]),
      api: {
        pin: (messageId) => {
          asked.push(messageId);
          return new Promise(() => undefined);
        },
      },
    });
    expect(pinButton(view, 1).getAttribute('aria-pressed')).toBe('false');
    expect(within(rowOf(view, 1)).queryByText('Pinned')).toBeNull();

    await person().click(pinButton(view, 1));

    expect(pinButton(view, 1).getAttribute('aria-pressed')).toBe('true');
    expect(within(rowOf(view, 1)).getByText('Pinned')).toBeDefined();
    expect(asked).toEqual([messageIdAt(1)]);
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a pinned message is marked, and unpinned the same way', async () => {
    const server = aServer([aPin(first)]);
    const letGo: string[] = [];
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        pins: server.pins,
        unpin: (messageId) => {
          letGo.push(messageId);
          server.pinned.splice(0);
          return Promise.resolve();
        },
      },
    });
    expect(within(rowOf(view, 1)).getByText('Pinned')).toBeDefined();
    expect(within(rowOf(view, 2)).queryByText('Pinned')).toBeNull();

    await person().click(pinButton(view, 1));
    await settle();

    expect(within(rowOf(view, 1)).queryByText('Pinned')).toBeNull();
    expect(letGo).toEqual([messageIdAt(1)]);
    view.unmountAll();
  });

  test('kept, the server’s list replaces the one painted: who pinned it, and anyone else’s pin', async () => {
    const server = aServer();
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        pins: server.pins,
        pin: () => {
          // Somebody else pinned the other one meanwhile; the server says who pinned this.
          server.pinned.push(aPin(first, { pinnedBy: BOB }), aPin(second));
          return Promise.resolve();
        },
      },
    });
    await person().click(pinButton(view, 1));
    await settle();
    expect(within(rowOf(view, 2)).getByText('Pinned')).toBeDefined();
    await openPins(view);
    expect(within(panelOf(view)).getAllByRole('listitem')[0]?.textContent).toContain(
      `Pinned by ${BOB.displayName}`,
    );
    view.unmountAll();
  });

  test('refused, it is put back and said, and Retry tries again', async () => {
    let refuse = true;
    const asked: string[] = [];
    const server = aServer();
    const view = await mountChannel({
      messages: page([first]),
      api: {
        pins: server.pins,
        pin: (messageId) => {
          asked.push(messageId);
          if (refuse) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
          server.pinned.push(aPin(first));
          return Promise.resolve();
        },
      },
    });
    await person().click(pinButton(view, 1));
    await settle();
    expect(pinButton(view, 1).getAttribute('aria-pressed')).toBe('false');
    expect(view.getByText(/^The message was not pinned\./)).toBeDefined();

    refuse = false;
    await act(async () => {
      await person().click(view.getByRole('button', { name: 'Retry' }));
    });
    await settle();
    expect(asked).toEqual([messageIdAt(1), messageIdAt(1)]);
    expect(pinButton(view, 1).getAttribute('aria-pressed')).toBe('true');
    view.unmountAll();
  });

  test('at the bound, the server’s words say what to do', async () => {
    const view = await mountChannel({
      messages: page([first]),
      api: { pin: () => Promise.reject(new ApiError(409, 'PINS_LIMIT', 'full')) },
    });
    await person().click(pinButton(view, 1));
    await settle();
    expect(view.getByText(/That is as many pins as a channel keeps\./)).toBeDefined();
    view.unmountAll();
  });

  test('someone not in the channel sees what is pinned, and has nothing to press', async () => {
    const view = await mountChannel({
      channelId: IDS.browse,
      channels: someChannels(),
      messages: page([aMessage(1, { channelId: IDS.browse })]),
      api: {
        pins: () => Promise.resolve([aPin(aMessage(1, { channelId: IDS.browse }))]),
      },
    });
    const row = rowOf(view, 1);
    expect(within(row).getByText('Pinned')).toBeDefined();
    expect(within(row).queryByRole('button', { name: /Pin to this channel|Unpin/ })).toBeNull();
    view.unmountAll();
  });
});

describe('the Pins panel', () => {
  test('loads, then lists each pin with its words, who said it, and who pinned it', async () => {
    let answer: (pins: PinList) => void = () => undefined;
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        pins: () =>
          new Promise<PinList>((resolve) => {
            answer = resolve;
          }),
      },
    });
    await openPins(view);
    expect(within(panelOf(view)).getByRole('status').textContent).toContain(
      'Loading pinned messages',
    );
    expectFocusOn(within(panelOf(view)).getByRole('heading', { name: /Pinned/ }));
    expect(toggle(view).getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      answer([aPin(second, { pinnedBy: null }), aPin(first)]);
      await Promise.resolve();
    });
    await settle();

    const items = within(panelOf(view)).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'deploys freeze on Fridays',
      'the runbook is here',
    ]);
    expect(items[0]?.textContent).toContain(BOB.displayName);
    expect(items[0]?.textContent).toContain('Pinned');
    expect(items[1]?.textContent).toContain(`Pinned by ${ALICE.displayName}`);
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('says when nothing is pinned', async () => {
    const view = await mountChannel({ messages: page([first]) });
    await openPins(view);
    expect(
      within(panelOf(view)).getByRole('heading', { name: 'Nothing pinned yet' }),
    ).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a failed read says so, and Retry reads it again, focus kept in the panel', async () => {
    // The feed asks for the same list to mark pinned messages: it fails there too, until it does not.
    let refuse = true;
    const view = await mountChannel({
      messages: page([first]),
      api: {
        pins: () =>
          refuse
            ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
            : Promise.resolve([aPin(first)]),
      },
    });
    await openPins(view);
    const alert = within(panelOf(view)).getByRole('alert');
    expect(alert.textContent).toContain('The pinned messages did not load.');
    await expectNoAxeViolations(view.container);

    refuse = false;

    await person().click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();

    expect(within(panelOf(view)).getAllByRole('listitem')).toHaveLength(1);
    expectFocusOn(within(panelOf(view)).getByRole('heading', { name: /Pinned/ }));
    view.unmountAll();
  });

  test('a member lets a pin go from its row, at once', async () => {
    const server = aServer([aPin(first)]);
    const view = await mountChannel({
      messages: page([first]),
      api: {
        pins: server.pins,
        unpin: () => {
          server.pinned.splice(0);
          return new Promise(() => undefined);
        },
      },
    });
    await openPins(view);
    await person().click(within(panelOf(view)).getByRole('button', { name: 'Unpin' }));
    expect(
      within(panelOf(view)).getByRole('heading', { name: 'Nothing pinned yet' }),
    ).toBeDefined();
    expect(within(rowOf(view, 1)).queryByText('Pinned')).toBeNull();
    view.unmountAll();
  });

  test('a pinned reply opens its thread in the panel’s place', async () => {
    const root = aMessage(2, {
      thread: {
        replyCount: 1,
        lastReplyAt: aMessage(4).createdAt,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
    const reply = aMessage(4, { parentId: root.id, thread: null, content: 'the answer' });
    const view = await mountChannel({
      messages: page([aMessage(1), root]),
      api: {
        pins: () => Promise.resolve([aPin(reply)]),
        thread: (): Promise<ThreadPage> => Promise.resolve({ data: [reply], nextCursor: null }),
      },
    });
    await openPins(view);
    await person().click(within(panelOf(view)).getByRole('button', { name: 'Open its thread' }));
    await settle();
    expect(view.queryByRole('complementary', { name: /^Pinned/ })).toBeNull();
    expect(view.container.querySelector(`[data-thread-root="${root.id}"]`)).not.toBeNull();
    view.unmountAll();
  });

  test('one panel at a time: the files take the pins’ place, and Esc returns to the control', async () => {
    const view = await mountChannel({
      messages: page([first]),
      api: { files: () => Promise.resolve({ data: [], nextCursor: null }) },
    });
    await openPins(view);
    await person().click(view.getByRole('button', { name: 'Files in this channel' }));
    await settle();
    expect(view.queryByRole('complementary', { name: /^Pinned/ })).toBeNull();
    expect(view.getByRole('complementary', { name: /^Files/ })).toBeDefined();

    await openPins(view);
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('complementary', { name: /^Pinned/ })).toBeNull();
    expectFocusOn(toggle(view));
    view.unmountAll();
  });

  test('PINS_UPDATED reads the channel’s pins again, and they show', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first]), api: { pins: server.pins } });
    act(() => {
      view.world.sockets.open();
    });
    await openPins(view);
    const before = server.asked;
    server.pinned.push(aPin(first));
    await act(async () => {
      view.world.sockets.deliver({ event: 'PINS_UPDATED', data: { channelId: IDS.api }, ts: 1 });
      await Promise.resolve();
    });
    await settle();
    expect(server.asked).toBe(before + 1);
    expect(within(panelOf(view)).getAllByRole('listitem')).toHaveLength(1);
    expect(within(rowOf(view, 1)).getByText('Pinned')).toBeDefined();
    view.unmountAll();
  });
});
