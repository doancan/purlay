/**
 * "Mark unread from here" (D-212) as a person meets it in a channel: the message's More menu asks the
 * server, the sidebar shows what the server answered, and the channel the person is looking at is not
 * read again by being looked at — not at the bottom, not on leaving — until it is opened again.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Channel, Message, ReadChannelResponse } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { installDom } from '../../testing/dom';
import { BOB, IDS, aChannel, aMessage, messageIdAt, someChannels } from '../../testing/fixtures';
import { mountChannel, page, type ChannelView } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { READ_DEBOUNCE_MS } from './use-mark-read';

installDom();

const channelsWith = (state: Channel['state']): Channel[] => [
  { ...aChannel(IDS.api, 'api'), state },
  ...someChannels().slice(1),
];

const second = aMessage(2, { sender: BOB });
const messages = [aMessage(1, { sender: BOB }), second, aMessage(3, { sender: BOB })];

const advance = (view: ChannelView, ms: number): void => {
  act(() => {
    view.feed.timers.advance(ms);
  });
};

const atBottom = (view: ChannelView): void => {
  view.metrics.top = 600;
  fireEvent.scroll(view.scroller());
};

const markUnread = async (view: ChannelView, message: Message): Promise<void> => {
  const row = view.container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
  if (row === null) throw new Error('no row');
  await person().click(within(row).getByRole('button', { name: 'More' }));
  await person().click(view.getByRole('menuitem', { name: 'Mark unread from here' }));
};

/** The channel's state as the sidebar and the badge read it: the channels' cache. */
const stateOf = (view: ChannelView): Channel['state'] | undefined =>
  view.world.client
    .getQueryData<Channel[]>(keys.channels(IDS.workspace))
    ?.find((channel) => channel.id === IDS.api)?.state;

describe('mark unread from here (D-212)', () => {
  test('asks the server, shows its answer, and the open channel is not read again', async () => {
    const reads: string[] = [];
    const unreads: string[] = [];
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(3),
        unreadCount: 0,
        unreadMentionCount: 0,
      }),
      messages: page(messages),
      api: {
        markRead: (_channel, id): Promise<ReadChannelResponse> => {
          reads.push(id);
          return Promise.resolve({ lastReadMessageId: id, unreadCount: 0, unreadMentionCount: 0 });
        },
        markUnread: (_channel, from): Promise<ReadChannelResponse> => {
          unreads.push(from);
          return Promise.resolve({
            lastReadMessageId: messageIdAt(1),
            unreadCount: 2,
            unreadMentionCount: 0,
          });
        },
      },
    });
    await markUnread(view, second);
    expect(unreads).toEqual([second.id]);
    // What the sidebar and the badge read is what the server answered.
    expect(stateOf(view)).toEqual({
      lastReadMessageId: messageIdAt(1),
      unreadCount: 2,
      unreadMentionCount: 0,
    });
    // Looking at it does not read it — not even when a new message arrives at the bottom, which
    // would otherwise read the channel to it and undo the mark…
    act(() => {
      view.world.sockets.open();
    });
    atBottom(view);
    await act(async () => {
      view.world.sockets.deliver({
        event: 'MESSAGE_CREATED',
        data: aMessage(4, { sender: BOB }),
        ts: 1,
      });
      await Promise.resolve();
    });
    atBottom(view);
    advance(view, READ_DEBOUNCE_MS * 4);
    expect(reads).toEqual([]);
    // …and leaving sends nothing either.
    view.unmountAll();
    expect(reads).toEqual([]);
  });

  test('refused, it says so, and the channel reads as it always did again', async () => {
    const reads: string[] = [];
    const view = await mountChannel({
      channels: channelsWith({
        lastReadMessageId: messageIdAt(2),
        unreadCount: 1,
        unreadMentionCount: 0,
      }),
      messages: page(messages),
      api: {
        markRead: (_channel, id): Promise<ReadChannelResponse> => {
          reads.push(id);
          return Promise.resolve({ lastReadMessageId: id, unreadCount: 0, unreadMentionCount: 0 });
        },
        markUnread: () => Promise.reject(new ApiError(500, 'INTERNAL', 'down')),
      },
    });
    await markUnread(view, second);
    await act(async () => {
      await Promise.resolve();
    });
    expect(view.getByText(/It could not be marked unread\./)).toBeDefined();
    atBottom(view);
    advance(view, READ_DEBOUNCE_MS);
    expect(reads).toEqual([messageIdAt(3)]);
    view.unmountAll();
  });

  test('is not offered in a channel the person only reads, with no position to move', async () => {
    const view = await mountChannel({
      channels: channelsWith(null),
      messages: page(messages),
    });
    const row = view.container.querySelector<HTMLElement>(`[data-message-id="${second.id}"]`);
    if (row === null) throw new Error('no row');
    await person().click(within(row).getByRole('button', { name: 'More' }));
    expect(view.queryByRole('menuitem', { name: 'Mark unread from here' })).toBeNull();
    view.unmountAll();
  });
});
