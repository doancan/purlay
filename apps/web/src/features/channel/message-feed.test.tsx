/**
 * The rules of `UX.md` §6 and §7, as numbers: where the reader is, where they are put,
 * when the channel counts as read, how a send looks on its way, and the keyboard.
 *
 * Layout is measured by `installScrollMetrics` and the observers are fired by hand. What
 * this cannot show — whether a real browser's own scroll anchoring agrees, whether the pill
 * is in view, how a long list *feels* — is stated where a test stops, and is Playwright's.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Channel, Message, ReadChannelResponse } from '@purlay/types';
import { ACK_DEADLINE_MS } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { installDom } from '../../testing/dom';
import {
  mountChannel,
  page,
  settle,
  type ChannelOptions,
  type ChannelView,
} from '../../testing/channel-harness';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  aChannel,
  aMessage,
  WHEN,
  messageIdAt,
  someChannels,
} from '../../testing/fixtures';
import { person } from '../../testing/user';
import * as Content from '../content/render-content';
import { SEEK_LIMIT_PAGES } from './message-feed';
import { READ_DEBOUNCE_MS } from './use-mark-read';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn, pressTab, tabOrder } from '../../testing/focus';

installDom();

const read = (id: string | null, unread = 0): ReadChannelResponse => ({
  lastReadMessageId: id,
  unreadCount: unread,
  unreadMentionCount: 0,
});

/** The `api` channel with the unread state a test names. */
const channelsWith = (state: Channel['state']): Channel[] => [
  { ...aChannel(IDS.api, 'api', { topic: 'Backend deploys and incident follow-ups' }), state },
  ...someChannels().slice(1),
];

/** What the API was asked to mark read, in order. */
const marking = (): {
  calls: string[];
  api: { markRead: (c: string, id: string) => Promise<ReadChannelResponse> };
} => {
  const calls: string[] = [];
  return {
    calls,
    api: {
      markRead: (_channel, id): Promise<ReadChannelResponse> => {
        calls.push(id);
        return Promise.resolve(read(id));
      },
    },
  };
};

const scrollTo = (view: ChannelView, top: number): void => {
  view.metrics.top = top;
  fireEvent.scroll(view.scroller());
};

const arrive = async (view: ChannelView, message: Message): Promise<void> => {
  await act(async () => {
    view.world.sockets.deliver({ event: 'MESSAGE_CREATED', data: message, ts: 1 });
    await Promise.resolve();
  });
};

const open = (view: ChannelView): void => {
  act(() => {
    view.world.sockets.open();
  });
};

const advance = (view: ChannelView, ms: number): void => {
  act(() => {
    view.feed.timers.advance(ms);
  });
};

const BOTTOM = 600; // scrollHeight 1000 − clientHeight 400

describe('where a channel opens', () => {
  test('at the bottom when there is nothing unread', async () => {
    const view = await mountChannel({ messages: page([aMessage(1), aMessage(2)]) });
    expect(view.metrics.assigned.at(-1)).toBe(BOTTOM);
    expect(view.container.querySelector('[data-feed-marker]')).toBeNull();
    view.unmountAll();
  });

  test('at the unread marker when there is one, a little above it, and not read until the bottom is reached', async () => {
    const m = marking();
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(1),
        unreadCount: 2,
        unreadMentionCount: 0,
      }),
      messages: page([aMessage(1), aMessage(2, { sender: BOB }), aMessage(3, { sender: BOB })]),
      layout: { markerTop: 300 },
      api: m.api,
    });
    expect(view.getByText('New')).toBeDefined();
    // The marker is a rule and a word in the danger colour, so it is seen as a place (D-118).
    expect(view.getByText('New').parentElement?.className).toContain('text-danger-text');
    expect(view.getByText('New').previousElementSibling?.className).toContain('border-danger');
    expect(view.metrics.assigned.at(-1)).toBe(252); // 300 − 48
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(m.calls).toEqual([]);
    scrollTo(view, 560);
    advance(view, READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([messageIdAt(3)]);
    view.unmountAll();
  });

  test('the marker is frozen at what it was when the channel opened, whatever reading does to the count', async () => {
    const m = marking();
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(1),
        unreadCount: 1,
        unreadMentionCount: 0,
      }),
      messages: page([aMessage(1), aMessage(2, { sender: BOB })]),
      api: m.api,
    });
    expect(view.container.querySelectorAll('[data-feed-marker]')).toHaveLength(1);
    // The server says it is all read now (what reading it causes): the marker stays.
    await act(async () => {
      view.world.client.setQueryData(
        ['channels', IDS.workspace],
        channelsWith(read(messageIdAt(2))),
      );
      await Promise.resolve();
    });
    expect(view.container.querySelectorAll('[data-feed-marker]')).toHaveLength(1);
    view.unmountAll();
  });

  test('a read position older than the first page is looked for before the feed is shown, and the reader opens on the real line', async () => {
    const asked: (string | undefined)[] = [];
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(2),
        unreadCount: 4,
        unreadMentionCount: 0,
      }),
      api: {
        messages: (_c, query) => {
          asked.push(query?.before);
          return query?.before === undefined
            ? Promise.resolve(page([aMessage(5), aMessage(6)], messageIdAt(5)))
            : new Promise((resolve) => {
                release = resolve;
              });
        },
      },
      layout: { markerTop: 300 },
    });
    // The first page holds nothing at or before the read position: the feed waits, with the
    // loading state, and asks for the next page by itself — no marker above the wrong message.
    expect(asked).toEqual([undefined, messageIdAt(5)]);
    expect(view.container.querySelector('[data-message-row]')).toBeNull();
    expect(view.getByText('Loading messages')).toBeDefined();
    await act(async () => {
      release(page([aMessage(1), aMessage(2), aMessage(3), aMessage(4)]));
      await Promise.resolve();
    });
    await settle();
    // The position is in hand: the marker is above the first message past it (the third), and the
    // reader is placed at it, once.
    const markers = view.container.querySelectorAll('[data-feed-marker]');
    expect(markers).toHaveLength(1);
    expect(markers[0]?.nextElementSibling?.getAttribute('data-message-id')).toBe(messageIdAt(3));
    expect(view.metrics.assigned.at(-1)).toBe(252);
    expect(asked).toHaveLength(2);
    view.unmountAll();
  });

  test('looking for the place stops after ten pages: the reader is shown what is there, not made to wait for ever', async () => {
    const asked: (string | undefined)[] = [];
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(1),
        unreadCount: 40,
        unreadMentionCount: 0,
      }),
      api: {
        messages: (_c, query) => {
          asked.push(query?.before);
          const n = asked.length + 10;
          return Promise.resolve(page([aMessage(n)], messageIdAt(n)));
        },
      },
    });
    for (let turn = 0; turn < 12; turn++) await settle();
    expect(asked).toHaveLength(SEEK_LIMIT_PAGES);
    expect(view.container.querySelector('[data-message-row]')).not.toBeNull();
    view.unmountAll();
  });

  test('"never read" puts the marker above the oldest message only when no older page is waiting', async () => {
    const complete = await mountChannel({
      channels: channelsWith({ lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 0 }),
      messages: page([aMessage(1, { sender: BOB }), aMessage(2, { sender: BOB })]),
    });
    expect(complete.container.querySelector('[data-feed-marker]')).not.toBeNull();
    complete.unmountAll();
    const partial = await mountChannel({
      channels: channelsWith({ lastReadMessageId: null, unreadCount: 2, unreadMentionCount: 0 }),
      messages: page([aMessage(5, { sender: BOB })], messageIdAt(4)),
    });
    expect(partial.container.querySelector('[data-feed-marker]')).toBeNull();
    partial.unmountAll();
  });
});

describe('what arrives while the reader is somewhere', () => {
  const first = [aMessage(1), aMessage(2, { sender: BOB })];

  test('at the bottom — or within 80px of it — the feed follows', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    scrollTo(view, 550); // 1000 − 550 − 400 = 50px from the bottom
    view.metrics.assigned.length = 0;
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(view.metrics.assigned).toContain(BOTTOM);
    expect(view.queryByRole('button', { name: /new message/ })).toBeNull();
    view.unmountAll();
  });

  test('scrolled up — even 81px — it does not move, and a pill counts what is waiting', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    scrollTo(view, 519); // 81px from the bottom
    view.metrics.assigned.length = 0;
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(view.metrics.assigned).toEqual([]);
    expect(view.getByRole('button', { name: '1 new message' })).toBeDefined();
    await arrive(view, aMessage(4, { sender: ALICE }));
    expect(view.getByRole('button', { name: '2 new messages' })).toBeDefined();
    expect(view.metrics.top).toBe(519);
    view.unmountAll();
  });

  test('the pill takes the reader to the bottom and goes away; so does getting there by scrolling', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    scrollTo(view, 0);
    await arrive(view, aMessage(3, { sender: BOB }));
    await person().click(view.getByRole('button', { name: '1 new message' }));
    expect(view.metrics.top).toBe(BOTTOM);
    expect(view.queryByRole('button', { name: /new message/ })).toBeNull();

    scrollTo(view, 0);
    await arrive(view, aMessage(4, { sender: BOB }));
    expect(view.getByRole('button', { name: '1 new message' })).toBeDefined();
    scrollTo(view, 590);
    expect(view.queryByRole('button', { name: /new message/ })).toBeNull();
    view.unmountAll();
  });

  // A browser reports a scroll on the next frame. Under load a message can land before that
  // frame, so the reader's place is what the scroller says now, not what the last report said.
  test('a scroll up the browser has not reported yet still keeps the reader where they are', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.top = 100; // scrolled up; no scroll event yet
    view.metrics.assigned.length = 0;
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(view.metrics.assigned).toEqual([]);
    expect(view.getByRole('button', { name: '1 new message' })).toBeDefined();
    view.unmountAll();
  });

  test('at the bottom when a tall message lands, the reader follows it: judged by where the bottom was', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1300; // the message that arrives is 300px tall
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(view.metrics.assigned).toContain(900);
    expect(view.queryByRole('button', { name: /new message/ })).toBeNull();
    view.unmountAll();
  });

  test('a scroll down to the bottom the browser has not reported yet is followed', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    scrollTo(view, 0);
    view.metrics.top = 590; // back at the bottom; no scroll event yet
    view.metrics.assigned.length = 0;
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(view.metrics.assigned).toContain(BOTTOM);
    view.unmountAll();
  });

  test('the late report of our own move to the bottom, after the list grew, keeps the reader there', async () => {
    // A picture drawn a frame after the feed went to the bottom: the browser reports that scroll
    // only once the list is already taller, before the resize is heard (seen live, 1 send in 3).
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1300;
    scrollTo(view, BOTTOM); // where the bottom was; nothing moved upward
    expect(view.metrics.assigned).toContain(900);
    view.unmountAll();
  });

  test('a scroll upward after the list grew is the reader leaving the bottom', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1300;
    scrollTo(view, BOTTOM - 200);
    expect(view.metrics.assigned).toEqual([]);
    view.unmountAll();
  });

  test('a box that changes size before a scroll up is reported leaves the reader alone', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.top = 100; // scrolled up; no scroll event yet
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1200;
    act(() => {
      view.feed.resize();
    });
    expect(view.metrics.assigned).toEqual([]);
    view.unmountAll();
  });

  test('a box that shrinks under a reader at the bottom keeps them there', async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    view.metrics.assigned.length = 0;
    view.metrics.clientHeight = 100; // the window got 300px shorter; the content did not move
    act(() => {
      view.feed.resize();
    });
    expect(view.metrics.assigned).toEqual([900]);
    view.unmountAll();
  });

  test("the person's own send always takes them to it, wherever they were", async () => {
    const view = await mountChannel({ messages: page(first) });
    open(view);
    scrollTo(view, 0);
    view.metrics.assigned.length = 0;
    act(() => {
      view.engine().send({ channelId: IDS.api, content: 'on my way' });
    });
    expect(view.metrics.assigned).toContain(BOTTOM);
    view.unmountAll();
  });

  test('a box that changes size keeps a reader at the bottom there, and leaves one who scrolled up alone', async () => {
    const view = await mountChannel({ messages: page(first) });
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1200;
    act(() => {
      view.feed.resize();
    });
    expect(view.metrics.assigned).toEqual([800]);

    scrollTo(view, 100);
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1500;
    act(() => {
      view.feed.resize();
    });
    expect(view.metrics.assigned).toEqual([]);
    expect(view.metrics.top).toBe(100);
    view.unmountAll();
  });
});

describe('a message somebody revised', () => {
  const revise = async (
    view: ChannelView,
    message: Message,
    change: { content?: string; editedAt?: string | null; deletedAt?: string | null },
    version: number,
  ): Promise<void> => {
    act(() => {
      view.world.sockets.deliver({
        event: 'MESSAGE_REVISED',
        data: {
          channelId: message.channelId,
          messageId: message.id,
          parentId: message.parentId,
          content: change.content ?? message.content,
          editedAt: change.editedAt ?? null,
          deletedAt: change.deletedAt ?? null,
          mentions: [],
        },
        version,
        ts: 1,
      });
    });
    // The cache tells its readers on the next task, not in this one.
    await settle();
  };
  const EDITED = '2026-09-09T09:00:00.000Z';

  test('shows the new words, and that they were edited, live', async () => {
    const original = aMessage(1, { sender: BOB });
    const view = await mountChannel({ messages: page([original]) });
    open(view);
    await revise(view, original, { content: 'better words', editedAt: EDITED }, 2);
    expect(view.getByText('better words')).toBeDefined();
    expect(view.queryByText('message 1')).toBeNull();
    expect(view.getByText('edited')).toBeDefined();
    view.unmountAll();
  });

  test('a reader at the bottom stays there when the last message grows in place', async () => {
    // A message that changes without a newer one arriving — its pictures drawn, its words edited
    // longer — makes the list taller; the reader at the bottom must not be left above it (#feed).
    const original = aMessage(1, { sender: BOB });
    const view = await mountChannel({ messages: page([original]) });
    open(view);
    view.metrics.assigned.length = 0;
    view.metrics.scrollHeight = 1300; // the revised message is 300px taller
    await revise(view, original, { content: 'a much longer message', editedAt: EDITED }, 2);
    act(() => {
      view.feed.resize();
    });
    expect(view.metrics.assigned).toContain(900);
    view.unmountAll();
  });

  test('an older revision arriving late is dropped: the newer words stay', async () => {
    const original = aMessage(1, { sender: BOB });
    const view = await mountChannel({ messages: page([original]) });
    open(view);
    await revise(view, original, { content: 'newest', editedAt: EDITED }, 3);
    await revise(view, original, { content: 'older', editedAt: EDITED }, 2);
    expect(view.getByText('newest')).toBeDefined();
    expect(view.queryByText('older')).toBeNull();
    view.unmountAll();
  });

  test('a deleted message nobody answered leaves the feed', async () => {
    const original = aMessage(1, { sender: BOB });
    const kept = aMessage(2, { sender: BOB });
    const view = await mountChannel({ messages: page([original, kept]) });
    open(view);
    await revise(view, original, { content: '', deletedAt: EDITED }, 2);
    expect(view.queryByText('message 1')).toBeNull();
    expect(view.getByText('message 2')).toBeDefined();
    expect(view.queryByText('This message was deleted.')).toBeNull();
    view.unmountAll();
  });

  test('a deleted message with replies stays as its tombstone, with its thread, and no reactions', async () => {
    const original = aMessage(1, {
      sender: BOB,
      thread: { replyCount: 2, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null },
      reactions: [{ emoji: '👍', userIds: [ALICE.id] }],
    });
    const view = await mountChannel({ messages: page([original]) });
    open(view);
    await revise(view, original, { content: '', deletedAt: EDITED }, 2);
    expect(view.getByText('This message was deleted.')).toBeDefined();
    expect(view.getByRole('button', { name: /2 replies/ })).toBeDefined();
    expect(view.queryByRole('button', { name: /👍/ })).toBeNull();
    view.unmountAll();
  });

  test('a tombstone is said in Turkish when the interface is', async () => {
    const original = aMessage(1, {
      sender: BOB,
      thread: { replyCount: 1, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null },
    });
    const view = await mountChannel({ messages: page([original]), locale: 'tr' });
    open(view);
    await revise(view, original, { content: '', deletedAt: EDITED }, 2);
    expect(view.getByText('Bu mesaj silindi.')).toBeDefined();
    view.unmountAll();
  });
});

describe('older messages', () => {
  const newer = [aMessage(5), aMessage(6, { sender: BOB })];
  const older = [aMessage(3), aMessage(4, { sender: BOB })];

  const twoPages = (second: () => Promise<ReturnType<typeof page>>): ChannelOptions => ({
    api: {
      messages: (_c, query) =>
        query?.before === undefined ? Promise.resolve(page(newer, messageIdAt(5))) : second(),
    },
  });

  test('load when the top comes into view, a page at a time, and the reader keeps their place', async () => {
    const asked: (string | undefined)[] = [];
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    const view = await mountChannel({
      api: {
        messages: (_c, query) => {
          asked.push(query?.before);
          return query?.before === undefined
            ? Promise.resolve(page(newer, messageIdAt(5)))
            : new Promise((resolve) => {
                release = resolve;
              });
        },
      },
    });
    scrollTo(view, 100);
    act(() => {
      view.feed.sentinelVisible();
    });
    await settle();
    expect(asked).toEqual([undefined, messageIdAt(5)]);
    expect(view.getByText('Loading older messages')).toBeDefined();
    act(() => {
      view.feed.sentinelVisible();
    });
    expect(asked).toHaveLength(2); // one at a time

    view.metrics.scrollHeight = 1600; // the older page is 600px taller
    view.metrics.assigned.length = 0;
    await act(async () => {
      release(page(older));
      await Promise.resolve();
    });
    await settle();
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(4);
    expect(view.metrics.assigned.at(-1)).toBe(700); // 100 + 600
    expect(view.getByText('This is the beginning of the channel')).toBeDefined();
    expect(view.feed.live.visible).toBe(0);
    view.unmountAll();
  });

  test('a page that lands after the box changed size gives the reader the place they had since', async () => {
    let release: (value: ReturnType<typeof page>) => void = () => undefined;
    const view = await mountChannel({
      api: {
        messages: (_c, query) =>
          query?.before === undefined
            ? Promise.resolve(page(newer, messageIdAt(5)))
            : new Promise((resolve) => {
                release = resolve;
              }),
      },
    });
    scrollTo(view, 200);
    view.metrics.scrollHeight = 1600; // something below grew while the reader read
    act(() => {
      view.feed.resize();
    });
    act(() => {
      view.feed.sentinelVisible();
    });
    await settle();
    view.metrics.scrollHeight = 2000; // the older page is 400px taller
    await act(async () => {
      release(page(older));
      await Promise.resolve();
    });
    await settle();
    expect(view.metrics.assigned.at(-1)).toBe(600); // 200 + 400, measured from 1600
    view.unmountAll();
  });

  test('a refresh that fails behind rows already on screen says they may be out of date, and Retry asks again', async () => {
    let fail = false;
    const view = await mountChannel({
      messages: () =>
        fail
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(page([aMessage(1, { sender: BOB })])),
    });
    expect(view.queryByText('What you see may be out of date')).toBeNull();
    fail = true;
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: keys.messages(IDS.api) });
    });
    await settle();
    expect(view.getByText('What you see may be out of date')).toBeDefined();
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(1);
    fail = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.queryByText('What you see may be out of date')).toBeNull();
    view.unmountAll();
  });

  test('a page that fails says so in the same row, and Try again asks again', async () => {
    let fail = true;
    const view = await mountChannel(
      twoPages(() =>
        fail ? Promise.reject(new ApiError(0, 'NETWORK', 'offline')) : Promise.resolve(page(older)),
      ),
    );
    act(() => {
      view.feed.sentinelVisible();
    });
    await settle();
    expect(view.getByText("Couldn't load older messages")).toBeDefined();
    fail = false;
    await person().click(view.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(view.container.querySelectorAll('[data-message-row]')).toHaveLength(4);
    view.unmountAll();
  });

  test('a page that keeps failing is asked for once and not in a loop; only Try again asks again', async () => {
    let asks = 0;
    const view = await mountChannel({
      ...twoPages(() => {
        asks += 1;
        return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      }),
      topStaysInView: true,
    });
    await settle();
    await settle();
    expect(view.getByText("Couldn't load older messages")).toBeDefined();
    // The first fetch, and the one retry the query client allows a transient failure: no more.
    const afterSettling = asks;
    await settle();
    await settle();
    expect(asks).toBe(afterSettling);
    expect(afterSettling).toBeLessThanOrEqual(2);

    await person().click(view.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(asks).toBeGreaterThan(afterSettling);
    view.unmountAll();
  });

  test('a thread link into history that fails to load is not chased in a loop either', async () => {
    let asks = 0;
    const view = await mountChannel({
      ...twoPages(() => {
        asks += 1;
        return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      }),
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(1)}`,
    });
    await settle();
    await settle();
    const afterSettling = asks;
    await settle();
    await settle();
    expect(asks).toBe(afterSettling);
    expect(afterSettling).toBeLessThanOrEqual(2);
    view.unmountAll();
  });

  test('a channel that fits on one page is not asked for more, and its observer is not left running', async () => {
    const view = await mountChannel({ messages: page(newer) });
    expect(view.feed.live.visible).toBe(0);
    expect(view.getByText('This is the beginning of the channel')).toBeDefined();
    view.unmountAll();
  });

  test('a page with more behind it shows no end yet, and cleans up its observers when it goes', async () => {
    const view = await mountChannel({ messages: page(newer, messageIdAt(4)) });
    expect(view.queryByText('This is the beginning of the channel')).toBeNull();
    expect(view.feed.live.visible).toBe(1);
    view.unmountAll();
    expect(view.feed.live).toEqual({ visible: 0, resized: 0, visibility: 0 });
  });
});

describe('when a channel counts as read', () => {
  const unread = channelsWith({
    lastReadMessageId: messageIdAt(1),
    unreadCount: 1,
    unreadMentionCount: 0,
  });
  const msgs = [aMessage(1), aMessage(2, { sender: BOB })];
  // The marker sits near the end of the list, so the opening scroll lands within reach of the bottom.
  const layout = { markerTop: 640 };

  test('after the bottom has held, once, with the newest message — and never again for the same one', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    advance(view, READ_DEBOUNCE_MS - 1);
    expect(m.calls).toEqual([]);
    advance(view, 1);
    expect(m.calls).toEqual([messageIdAt(2)]);
    scrollTo(view, BOTTOM);
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(m.calls).toEqual([messageIdAt(2)]);
    view.unmountAll();
  });

  test('each new arrival at the bottom is read in turn, forward only', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    open(view);
    advance(view, READ_DEBOUNCE_MS);
    await arrive(view, aMessage(3, { sender: BOB }));
    advance(view, READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([messageIdAt(2), messageIdAt(3)]);
    view.unmountAll();
  });

  test('scrolling through the bottom is one request, not one per scroll event', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    for (const top of [100, 600, 300, 600, 590]) scrollTo(view, top);
    advance(view, READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([messageIdAt(2)]);
    view.unmountAll();
  });

  test('is not when the reader is above the bottom, and is when they get there', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    open(view);
    scrollTo(view, 0);
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(m.calls).toEqual([]);
    scrollTo(view, 560);
    advance(view, READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([messageIdAt(2)]);
    view.unmountAll();
  });

  test('leaving reads what the reader had reached, without waiting out the pause', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    open(view);
    advance(view, READ_DEBOUNCE_MS);
    await arrive(view, aMessage(3, { sender: BOB }));
    expect(m.calls).toEqual([messageIdAt(2)]);
    view.unmountAll();
    expect(m.calls).toEqual([messageIdAt(2), messageIdAt(3)]);
  });

  test('leaving a channel never reached the bottom of reads nothing', async () => {
    const m = marking();
    // Opened at a marker far from the bottom, and left without ever getting there.
    const view = await mountChannel({
      channels: unread,
      messages: page(msgs),
      layout: { markerTop: 100 },
      api: m.api,
    });
    view.unmountAll();
    expect(m.calls).toEqual([]);
  });

  test('is not when the page is hidden, and is when it is shown again', async () => {
    const m = marking();
    const view = await mountChannel({ channels: unread, messages: page(msgs), layout, api: m.api });
    act(() => {
      view.feed.setPageVisible(false);
    });
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(m.calls).toEqual([]);
    act(() => {
      view.feed.setPageVisible(true);
    });
    advance(view, READ_DEBOUNCE_MS);
    expect(m.calls).toEqual([messageIdAt(2)]);
    view.unmountAll();
  });

  test('is not for a channel the person has not joined', async () => {
    const m = marking();
    const view = await mountChannel({
      channelId: IDS.browse,
      channels: someChannels(),
      messages: page([aMessage(1, { channelId: IDS.browse })]),
      api: m.api,
    });
    advance(view, READ_DEBOUNCE_MS * 4);
    view.unmountAll();
    expect(m.calls).toEqual([]);
  });

  test('a position already read is not sent again, and a failed request is tried again at the next arrival', async () => {
    const calls: string[] = [];
    let fail = true;
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(2),
        unreadCount: 0,
        unreadMentionCount: 0,
      }),
      messages: page(msgs),
      api: {
        markRead: (_c, id) => {
          calls.push(id);
          return fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'no'))
            : Promise.resolve(read(id));
        },
      },
    });
    open(view);
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(calls).toEqual([]);
    await arrive(view, aMessage(3, { sender: BOB }));
    advance(view, READ_DEBOUNCE_MS);
    await settle();
    expect(calls).toEqual([messageIdAt(3)]);
    fail = false;
    await arrive(view, aMessage(4, { sender: BOB }));
    advance(view, READ_DEBOUNCE_MS);
    await settle();
    expect(calls).toEqual([messageIdAt(3), messageIdAt(4)]);
    view.unmountAll();
  });
});

describe('a send on its way', () => {
  test('is on screen at once as sending, is acknowledged, and its echo does not move it', async () => {
    const view = await mountChannel({ messages: page([aMessage(1, { sender: BOB })]) });
    open(view);
    let id = '';
    act(() => {
      id = view.engine().send({ channelId: IDS.api, content: 'hello' });
    });
    expect(view.getByText('hello')).toBeDefined();
    expect(view.getByRole('img', { name: 'Sending' })).toBeDefined();

    act(() => {
      view.world.sockets.deliver({ event: 'ACK', data: { id }, refId: id, ts: 1 });
    });
    expect(view.queryByRole('img', { name: 'Sending' })).toBeNull();
    expect(view.getByText('Message sent')).toBeDefined();

    const before = Array.from(view.container.querySelectorAll('[data-message-row]')).map((r) =>
      r.getAttribute('data-message-id'),
    );
    await arrive(view, aMessage(1, { id, sender: ME, content: 'hello' }));
    const after = Array.from(view.container.querySelectorAll('[data-message-row]')).map((r) =>
      r.getAttribute('data-message-id'),
    );
    expect(after).toEqual(before);
    expect(view.getAllByText('hello')).toHaveLength(1);
    view.unmountAll();
  });

  test('with no ACK in three seconds it is failed, said so, and Retry sends the same id again', async () => {
    const view = await mountChannel({ messages: page([aMessage(1, { sender: BOB })]) });
    open(view);
    let id = '';
    act(() => {
      id = view.engine().send({ channelId: IDS.api, content: 'hello' });
    });
    act(() => {
      view.world.timers.advance(ACK_DEADLINE_MS);
    });
    const row = view.getByText('hello').closest('[data-message-row]');
    expect(row?.querySelector('[data-body]')?.className).toContain('border-danger');
    expect(row?.textContent).toContain('Failed to send');
    expect(view.getByText('Message failed to send')).toBeDefined();

    await person().click(view.getByRole('button', { name: 'Retry' }));
    const sends = view.world.sockets.sent('MESSAGE_SEND').map((f) => f.id);
    expect(sends).toEqual([id, id]);
    expect(view.queryByRole('button', { name: 'Retry' })).toBeNull();
    view.unmountAll();
  });

  test('a send refused because the person is not in the channel says so, and how to get in (D-156)', async () => {
    const view = await mountChannel({ messages: page([aMessage(1, { sender: BOB })]) });
    open(view);
    let id = '';
    act(() => {
      id = view.engine().send({ channelId: IDS.api, content: 'in flight' });
    });
    act(() => {
      view.world.sockets.deliver({
        event: 'ERROR',
        data: { code: 'NOT_A_CHANNEL_MEMBER', message: 'Join the channel to write in it.' },
        refId: id,
        ts: 1,
      });
    });
    expect(view.getByText('Failed to send')).toBeDefined();
    expect(
      view.getByText('You are not in this channel. Join it to write here, then try again.'),
    ).toBeDefined();
    expect(view.getByRole('button', { name: 'Retry' })).toBeDefined();
    view.unmountAll();
  });

  test("Delete takes a failed send away, and the reason is shown in words, not the server's", async () => {
    const view = await mountChannel({ messages: page([aMessage(1, { sender: BOB })]) });
    open(view);
    let id = '';
    act(() => {
      id = view.engine().send({ channelId: IDS.api, content: 'too long' });
    });
    act(() => {
      view.world.sockets.deliver({
        event: 'ERROR',
        data: { code: 'RATE_LIMITED', message: 'Slow down.' },
        refId: id,
        ts: 1,
      });
    });
    expect(view.getByText('You are going too fast. Wait a moment and try again.')).toBeDefined();
    expect(view.queryByText('Slow down.')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Delete' }));
    expect(view.queryByText('too long')).toBeNull();
    view.unmountAll();
  });

  test('replies are not in the feed: a pending reply to a root stays out of it', async () => {
    const view = await mountChannel({ messages: page([aMessage(1, { sender: BOB })]) });
    open(view);
    act(() => {
      view.engine().send({ channelId: IDS.api, content: 'a reply', parentId: messageIdAt(1) });
    });
    expect(view.queryByText('a reply')).toBeNull();
    view.unmountAll();
  });
});

describe('time', () => {
  test("a row's age moves on with the clock, once a minute and not before", async () => {
    const view = await mountChannel({
      messages: page([aMessage(1, { createdAt: '2026-09-09T11:59:40.000Z' })]),
    });
    const label = (): string => view.container.querySelector('time')?.textContent ?? '';
    expect(label()).toBe('now');
    view.feed.clock.now = new Date(Date.UTC(2026, 8, 9, 12, 5, 0));
    advance(view, 59_000);
    advance(view, 61_000);
    expect(label()).not.toBe('now');
    view.unmountAll();
  });
});

describe('the keyboard', () => {
  const three = [aMessage(1), aMessage(2, { sender: BOB }), aMessage(3, { sender: BOB })];
  const rowsOf = (view: ChannelView): HTMLElement[] =>
    Array.from(view.container.querySelectorAll<HTMLElement>('[data-message-row]'));
  const press = (el: Element, key: string, init: object = {}): void => {
    fireEvent.keyDown(el, { key, ...init });
  };

  test('one row is in the tab order — the newest — and focusing another moves it', async () => {
    const view = await mountChannel({ messages: page(three) });
    expect(rowsOf(view).map((r) => r.tabIndex)).toEqual([-1, -1, 0]);
    act(() => {
      rowsOf(view)[0]?.focus();
    });
    expect(rowsOf(view).map((r) => r.tabIndex)).toEqual([0, -1, -1]);
    view.unmountAll();
  });

  test('↑ ↓ Home End move between rows, from a row or from nowhere, and stop at the ends', async () => {
    const view = await mountChannel({ messages: page(three) });
    const [a, b, c] = rowsOf(view) as [HTMLElement, HTMLElement, HTMLElement];
    act(() => {
      c.focus();
    });
    press(c, 'ArrowUp');
    expectFocusOn(b);
    press(b, 'ArrowUp');
    expectFocusOn(a);
    press(a, 'ArrowUp');
    expectFocusOn(a);
    press(a, 'ArrowDown');
    expectFocusOn(b);
    press(b, 'End');
    expectFocusOn(c);
    press(c, 'ArrowDown');
    expectFocusOn(c);
    press(c, 'Home');
    expectFocusOn(a);
    // From the feed's own box, with no row focused: ↓ is the first, ↑ the last.
    const feed = view.getByRole('feed');
    press(feed, 'ArrowDown');
    expectFocusOn(a);
    press(feed, 'ArrowUp');
    expectFocusOn(c);
    view.unmountAll();
  });

  test('keys with a modifier, other keys and a text box are left alone', async () => {
    const view = await mountChannel({ messages: page(three) });
    const [a, b] = rowsOf(view) as [HTMLElement, HTMLElement];
    act(() => {
      b.focus();
    });
    press(b, 'ArrowUp', { ctrlKey: true });
    press(b, 'ArrowUp', { metaKey: true });
    press(b, 'ArrowUp', { altKey: true });
    press(b, 'a');
    expectFocusOn(b);
    const field = document.createElement('input');
    a.append(field);
    press(field, 'ArrowDown');
    expectFocusOn(b);
    view.unmountAll();
  });

  test('Escape goes to the composer, and something else that already handled it keeps it', async () => {
    const view = await mountChannel({ messages: page(three) });
    const [, b] = rowsOf(view) as [HTMLElement, HTMLElement];
    act(() => {
      b.focus();
    });
    press(b, 'Escape');
    expectFocusOn(view.getByLabelText('Message api'));
    act(() => {
      b.focus();
    });
    fireEvent.keyDown(b, { key: 'Escape', cancelable: true });
    view.unmountAll();
  });

  test('a row has a name a screen reader can use, and the feed is a feed', async () => {
    const view = await mountChannel({ messages: page(three) });
    expect(rowsOf(view)[0]?.getAttribute('aria-label')).toContain('Alice');
    expect(view.getByRole('feed', { name: 'Messages in api' }).getAttribute('aria-busy')).toBe(
      'false',
    );
    view.unmountAll();
  });

  test('Escape finds the composer even without its mark, and does nothing when there is none', async () => {
    const view = await mountChannel({ messages: page(three) });
    const [, b] = rowsOf(view) as [HTMLElement, HTMLElement];
    const box = view.getByLabelText('Message api');
    box.removeAttribute('data-composer');
    act(() => {
      b.focus();
    });
    press(b, 'Escape');
    expectFocusOn(box);
    box.remove();
    act(() => {
      b.focus();
    });
    press(b, 'Escape');
    expectFocusOn(b);
    view.unmountAll();
  });
});

describe('the feed is one Tab stop (D-168)', () => {
  // Every kind of control a message holds, in the rows above the newest: a link, a reaction, a
  // code block's buttons and the block, a thread's line.
  const busy = (): Message[] => [
    aMessage(1, {
      content: 'see https://example.com/a for it',
      reactions: [{ emoji: '👍', userIds: [BOB.id] }],
    }),
    aMessage(2, {
      sender: BOB,
      content: '```ts\nconst a = 1;\n```',
      thread: { replyCount: 2, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null },
    }),
    aMessage(3, { sender: BOB, content: 'the newest, with a link https://example.com/c' }),
  ];
  const rowsOf = (view: ChannelView): HTMLElement[] =>
    Array.from(view.container.querySelectorAll<HTMLElement>('[data-message-row]'));
  const describeStop = (stop: Element | null): string =>
    stop === null
      ? 'nothing'
      : stop.matches('[data-message-row]')
        ? 'row'
        : stop.matches('textarea')
          ? 'composer'
          : (stop.getAttribute('aria-label') ?? stop.textContent.trim());
  const tab = (shift = false): string => {
    let reached: HTMLElement | null = null;
    act(() => {
      reached = pressTab(shift);
    });
    return describeStop(reached);
  };
  // Shift+Tab out of the box passes the composer's own controls (the formatting row, D-181) first: it
  // comes back to the row they follow, and the walk says how many controls were in between.
  const tabBackToRow = (): string => {
    for (let press = 0; press < 20; press++) {
      const stop = tab(true);
      if (stop.startsWith('row')) return stop;
    }
    throw new Error('Shift+Tab never came back to a row');
  };
  const feedStops = (view: ChannelView): HTMLElement[] =>
    tabOrder().filter((stop) => view.getByRole('feed').contains(stop));

  test('from the header, Tab reaches the newest row, and the next Tab leaves it: no control of another row is on the way', async () => {
    const view = await mountChannel({ messages: page(busy()) });
    const [, , newest] = rowsOf(view) as [HTMLElement, HTMLElement, HTMLElement];
    // Nothing focused in the feed: one stop in it, the newest row.
    expect(feedStops(view)).toEqual([newest]);
    // From the header's last control.
    const header = view.getByRole('heading', { level: 1 }).closest('header');
    const last = header === null ? undefined : tabOrder(header).at(-1);
    if (last === undefined) throw new Error('the header has no control');
    act(() => {
      last.focus();
    });
    expect(tab()).toBe('row');
    expectFocusOn(newest);
    // Its own link, then its bar, then out to the composer.
    const walk: string[] = [];
    for (let press = 0; press < 30; press++) {
      const stop = tab();
      walk.push(stop);
      if (stop === 'composer') break;
    }
    expect(walk[0]).toMatch(/^https:\/\/example.com\/c/);
    expect(walk.at(-1)).toBe('composer');
    expect(walk).not.toContain('Copy code');
    expect(walk.some((stop) => stop.startsWith('👍'))).toBe(false);
    for (const stop of walk.slice(0, -1)) expect(stop).not.toBe('row');
    // Shift+Tab from the composer comes back to the row, not to the last control it passed.
    expect(tabBackToRow()).toBe('row');
    expectFocusOn(newest);
    view.unmountAll();
  });

  test('↑ moves to another row, and Tab then walks that row’s controls, only that row’s', async () => {
    const view = await mountChannel({ messages: page(busy()) });
    const [first, second, newest] = rowsOf(view) as [HTMLElement, HTMLElement, HTMLElement];
    act(() => {
      newest.focus();
    });
    fireEvent.keyDown(newest, { key: 'ArrowUp' });
    expectFocusOn(second);
    // The code block's buttons, the block itself and the thread's line are this row's stops.
    const inSecond = feedStops(view).filter((stop) => second.contains(stop) && stop !== second);
    const named = inSecond.map(describeStop);
    expect(named).toContain('Copy code');
    expect(named).toContain('ts, 1 line');
    expect(feedStops(view).some((stop) => first.contains(stop))).toBe(false);
    expect(feedStops(view).some((stop) => newest.contains(stop))).toBe(false);
    fireEvent.keyDown(second, { key: 'ArrowUp' });
    expectFocusOn(first);
    const walk: string[] = [];
    for (let press = 0; press < 30; press++) {
      const stop = tab();
      walk.push(stop);
      if (stop === 'composer') break;
    }
    expect(walk[0]).toMatch(/^https:\/\/example.com\/a/);
    expect(walk.some((stop) => stop.startsWith('👍'))).toBe(true);
    expect(walk).not.toContain('Copy code');
    expect(walk.at(-1)).toBe('composer');
    // And the row the keyboard left is the one Tab comes back to.
    expect(tabBackToRow()).toBe('row');
    expectFocusOn(first);
    view.unmountAll();
  });

  test('a control of a row that is not the current one still answers the pointer', async () => {
    const calls: string[] = [];
    const view = await mountChannel({
      messages: page(busy()),
      api: {
        unreact: (_id, emoji) => {
          calls.push(`unreact ${emoji}`);
          return Promise.resolve({ reactions: [] });
        },
        react: (_id, emoji) => {
          calls.push(`react ${emoji}`);
          return Promise.resolve({ reactions: [{ emoji, userIds: [BOB.id, ME.id] }] });
        },
      },
    });
    const [first] = rowsOf(view) as [HTMLElement];
    const chip = Array.from(first.querySelectorAll('button')).find((b) =>
      (b.getAttribute('aria-label') ?? '').startsWith('👍'),
    );
    const link = first.querySelector('a[href="https://example.com/a"]');
    if (chip === undefined || link === null) throw new Error('the first row was not drawn whole');
    expect(chip.getAttribute('tabindex')).toBe('-1');
    expect(link.getAttribute('tabindex')).toBe('-1');
    // Still a link with its address, still a named button: browse mode and a click both reach them.
    expect(link.closest('[inert], [aria-hidden="true"]')).toBeNull();
    fireEvent.click(chip);
    await settle();
    expect(calls).toEqual(['react 👍']);
    view.unmountAll();
  });

  test('the feed with its rows out of the Tab order passes the accessibility audit', async () => {
    const view = await mountChannel({ messages: page(busy()) });
    await expectNoAxeViolations(view.getByRole('feed'));
    act(() => {
      rowsOf(view)[0]?.focus();
    });
    await expectNoAxeViolations(view.getByRole('feed'));
    view.unmountAll();
  });
});

describe('re-rendering', () => {
  test('a new message draws one new row and leaves the others as they were', async () => {
    const draw = spyOn(Content, 'renderContent');
    const view = await mountChannel({
      messages: page([aMessage(1), aMessage(2, { sender: BOB }), aMessage(3)]),
    });
    open(view);
    const before = draw.mock.calls.length;
    await arrive(view, aMessage(4, { sender: BOB }));
    // The new row, and the one that was the tab stop and no longer is — no others.
    expect(draw.mock.calls.slice(before).map(([content]) => content)).toEqual([
      'message 3',
      'message 4',
    ]);
    draw.mockRestore();
    view.unmountAll();
  });
});
