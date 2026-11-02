/**
 * All unreads (D-216): which channels it lists, what it asks the server for, what it shows, and that
 * Mark read reads only what was shown.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { Channel, MessagePage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { installDom } from '../../testing/dom';
import { ApiError } from '../../data/errors';
import {
  BOB,
  IDS,
  ME,
  aChannel,
  aMessage,
  aSignedInApi,
  messageIdAt,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { UNREADS_PAGE } from './unreads-screen';
import { waitingChannels } from './waiting';

installDom();

const state = (position: string | null, unread: number): Channel['state'] => ({
  lastReadMessageId: position,
  unreadCount: unread,
  unreadMentionCount: 0,
});

const visit = async (channels: Channel[], api: Partial<Api> = {}): ReturnType<typeof renderApp> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: '/w/acme/unreads',
      api: aSignedInApi({ channels: () => Promise.resolve(channels), ...api }),
    },
  );
  await settle();
  return view;
};

describe('which channels wait', () => {
  test('joined, unread and not muted; a channel only seen, read, or set to tell nothing is not', () => {
    const waiting = waitingChannels([
      aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 2) }),
      aChannel(IDS.deploys, 'deploys', { state: state(messageIdAt(1), 0) }),
      aChannel(IDS.incidents, 'incidents', { state: state(null, 3), notificationLevel: 'none' }),
      aChannel(IDS.browse, 'browse', { state: null }),
    ]);
    expect(waiting.map((channel) => channel.name)).toEqual(['api']);
  });
});

describe('the screen', () => {
  test('asks for what is after the position, a page, and shows it oldest first', async () => {
    const asked: Parameters<Api['messages']>[1][] = [];
    const page: MessagePage = {
      data: [
        aMessage(2, { sender: BOB, content: 'second' }),
        aMessage(3, { sender: BOB, content: 'third' }),
      ],
      nextCursor: null,
    };
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 2) })], {
      messages: (_channel, query = {}) => {
        asked.push(query);
        return Promise.resolve(page);
      },
    });
    expect(asked).toEqual([{ after: messageIdAt(1), limit: UNREADS_PAGE }]);
    const words = view.getAllByText(/second|third/).map((node) => node.textContent);
    expect(words).toEqual(['second', 'third']);
    expect(view.getByText('2 new')).toBeDefined();
  });

  test('Mark read reads up to the newest shown, and no further', async () => {
    const reads: string[] = [];
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 5) })], {
      messages: () =>
        Promise.resolve({ data: [aMessage(2, { sender: BOB })], nextCursor: messageIdAt(2) }),
      markRead: (_channel, id) => {
        reads.push(id);
        return Promise.resolve({ lastReadMessageId: id, unreadCount: 3, unreadMentionCount: 0 });
      },
    });
    // More waits than was shown: it says so, and leads to the channel.
    expect(view.getByRole('link', { name: /More in/ })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Mark read' }));
    await settle();
    expect(reads).toEqual([messageIdAt(2)]);
  });

  test('a refused Mark read says so', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      messages: () => Promise.resolve({ data: [aMessage(2, { sender: BOB })], nextCursor: null }),
      markRead: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    await person().click(view.getByRole('button', { name: 'Mark read' }));
    expect(await view.findByText(/It could not be marked read\./)).toBeDefined();
  });

  test('who a message really mentions is highlighted, as in the feed', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      messages: () =>
        Promise.resolve({
          data: [
            aMessage(2, {
              sender: BOB,
              content: '@dogancan and @bob, not @carol',
              // Carol is nobody this workspace knows: named, but not a mention.
              mentions: [ME.id, BOB.id, '00000000-0000-4000-8000-00000000ca01'],
            }),
          ],
          nextCursor: null,
        }),
    });
    const marked = [...view.container.querySelectorAll('[data-mention]')];
    expect(marked.map((node) => node.textContent)).toEqual(['@dogancan', '@bob']);
    expect(marked[0]?.hasAttribute('data-mention-me')).toBe(true);
    expect(marked[1]?.hasAttribute('data-mention-me')).toBe(false);
  });

  test('a code reference links into the channel’s repository, as in the feed (D-223)', async () => {
    const view = await visit(
      [
        aChannel(IDS.api, 'api', {
          state: state(messageIdAt(1), 1),
          codeRepository: 'acme/api',
        }),
      ],
      {
        messages: () =>
          Promise.resolve({
            data: [aMessage(2, { content: 'see src/a.ts:4' })],
            nextCursor: null,
          }),
      },
    );
    expect(view.container.querySelector('a[data-code-reference]')?.getAttribute('href')).toBe(
      'https://github.com/acme/api/blob/HEAD/src/a.ts#L4',
    );
  });

  test('a channel whose new messages could not be loaded says so, and Retry asks again', async () => {
    let answers = 0;
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      messages: () => {
        answers += 1;
        return answers === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              data: [aMessage(2, { sender: BOB, content: 'back' })],
              nextCursor: null,
            });
      },
    });
    expect(view.getByText('What is new here could not be loaded.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('back')).toBeDefined();
    expect(view.queryByText('What is new here could not be loaded.')).toBeNull();
  });

  test('replies waiting in threads, and no new message in the feed, are said, with a way in', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(9), 2) })], {
      messages: () => Promise.resolve({ data: [], nextCursor: null }),
    });
    expect(view.getByText('2 replies wait in threads.')).toBeDefined();
    expect(view.getByRole('link', { name: 'Open the channel' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.api}`,
    );
    expect(view.queryByRole('button', { name: 'Mark read' })).toBeNull();
  });

  test('a channel never read shows its newest page, oldest first', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(null, 2) })], {
      messages: () =>
        Promise.resolve({
          data: [
            aMessage(3, { sender: BOB, content: 'newer' }),
            aMessage(2, { sender: BOB, content: 'older' }),
          ],
          nextCursor: null,
        }),
    });
    expect(view.getAllByText(/older|newer/).map((node) => node.textContent)).toEqual([
      'older',
      'newer',
    ]);
  });

  test('with nothing waiting it says so, and the sidebar has no row for it', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/c/' + IDS.api,
      api: aSignedInApi({
        channels: () =>
          Promise.resolve([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 0) })]),
      }),
    });
    await settle();
    const sidebar = within(view.getByRole('complementary', { name: 'Workspace' }));
    expect(sidebar.queryByRole('link', { name: 'All unreads' })).toBeNull();
    view.unmount();
    const empty = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 0) })]);
    expect(empty.getByText('All caught up')).toBeDefined();
  });

  test('the sidebar leads to it while a channel waits', async () => {
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/c/' + IDS.deploys,
      api: aSignedInApi({
        channels: () =>
          Promise.resolve([
            aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 2) }),
            aChannel(IDS.deploys, 'deploys', { state: state(messageIdAt(1), 0) }),
          ]),
      }),
    });
    await settle();
    const sidebar = within(view.getByRole('complementary', { name: 'Workspace' }));
    await person().click(sidebar.getByRole('link', { name: 'All unreads' }));
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/unreads');
  });
});
