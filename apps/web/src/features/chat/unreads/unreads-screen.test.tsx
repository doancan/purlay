/**
 * All unreads (D-216): which channels it lists, what it asks the server for, what it shows, and that
 * Mark read reads only what was shown.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Attachment, Channel, ChannelCatchUp, MessagePage } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { installDom } from '../../../testing/dom';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import {
  BOB,
  IDS,
  ME,
  aChannel,
  aMessage,
  aSignedInApi,
  messageIdAt,
} from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { settle } from '../../../testing/channel-harness';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { UNREADS_PAGE } from './unreads-screen';
import { waitingChannels } from './waiting';

installDom();

const catchUp = (roots: MessagePage): ChannelCatchUp => ({
  roots,
  threads: [],
  nextThreadCursor: null,
});

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
  test('requests the server catch-up page instead of guessing a never-read history boundary', async () => {
    const asked: Parameters<Api['unreads']>[1][] = [];
    const view = await visit([aChannel(IDS.api, 'api', { state: state(null, 25) })], {
      unreads: (_channel, query) => {
        asked.push(query);
        return Promise.resolve({
          roots: {
            data: [aMessage(1, { content: 'First waiting handover' })],
            nextCursor: messageIdAt(1),
          },
          threads: [],
          nextThreadCursor: null,
        });
      },
    });
    expect(await view.findByText('First waiting handover')).toBeDefined();
    expect(asked).toEqual([{ limit: UNREADS_PAGE }]);
  });

  test('waiting threads link to their first unread reply and more pages preserve those already displayed', async () => {
    const asked: (string | undefined)[] = [];
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 2) })], {
      unreads: (_channel, query) => {
        asked.push(query?.afterThread);
        const more = query?.afterThread !== undefined;
        return Promise.resolve({
          roots: { data: [], nextCursor: null },
          threads: [
            {
              root: aMessage(more ? 8 : 7, {
                content: more ? 'Another handover' : 'Older handover',
              }),
              firstUnreadMessageId: messageIdAt(more ? 10 : 9),
              unreadCount: 1,
            },
          ],
          nextThreadCursor: more ? null : messageIdAt(7),
        });
      },
    });
    expect(view.getByRole('link', { name: /Read unread replies/ }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.api}?message=${messageIdAt(9)}`,
    );
    expect(view.queryByRole('button', { name: 'Mark read' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'More unread threads' }));
    await settle();
    expect(view.getByText('Older handover')).toBeDefined();
    expect(view.getByText('Another handover')).toBeDefined();
    expect(asked).toEqual([undefined, messageIdAt(7)]);
  });

  test('an extra thread-page failure preserves displayed roots and threads, and Retry appends the missing page', async () => {
    let attempts = 0;
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 3) })], {
      unreads: (_channel, query) => {
        const more = query?.afterThread !== undefined;
        if (more && ++attempts === 1) return Promise.reject(new Error('offline'));
        return Promise.resolve({
          roots: {
            data: more ? [] : [aMessage(2, { content: 'Displayed root' })],
            nextCursor: null,
          },
          threads: [
            {
              root: aMessage(more ? 8 : 7, {
                content: more ? 'Next waiting thread' : 'Displayed thread',
              }),
              firstUnreadMessageId: messageIdAt(more ? 10 : 9),
              unreadCount: 1,
            },
          ],
          nextThreadCursor: more ? null : messageIdAt(7),
        });
      },
    });
    await person().click(view.getByRole('button', { name: 'More unread threads' }));
    await settle();
    expect(view.getByText('Displayed root')).toBeDefined();
    expect(view.getByText('Displayed thread')).toBeDefined();
    expect(view.getByRole('button', { name: 'Mark read' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Displayed thread')).toBeDefined();
    expect(view.getByText('Next waiting thread')).toBeDefined();
    expect(attempts).toBe(2);
  });

  test('a channel-list failure never claims everything was read, and Retry recovers', async () => {
    let offline = true;
    const view = await visit([], {
      channels: () => {
        return offline
          ? Promise.reject(new Error('offline'))
          : Promise.resolve([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })]);
      },
      unreads: () =>
        Promise.resolve(
          catchUp({ data: [aMessage(2, { content: 'Waiting update' })], nextCursor: null }),
        ),
    });
    const notice = await view.findByText('What is new here could not be loaded.');
    expect(view.queryByText('All caught up')).toBeNull();
    const error = notice.closest('section');
    if (error === null) throw new Error('The load failure has no recovery section');
    offline = false;
    await person().click(within(error).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Waiting update')).toBeDefined();
  });

  test('a file-only unread message has its filename and authenticated download', async () => {
    const file: Attachment = {
      id: '01995f7b-0000-7000-8000-000000000002',
      fileName: 'Vardiya listesi.pdf',
      mimeType: 'application/octet-stream',
      sizeBytes: 1536,
      kind: 'file',
      width: null,
      height: null,
    };
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({
            data: [aMessage(2, { content: '', attachments: [file] })],
            nextCursor: null,
          }),
        ),
    });
    const download = view.getByRole('link', { name: /Vardiya listesi\.pdf/ });
    expect(download.getAttribute('href')).toBe(`/api/attachments/${file.id}`);
    expect(download.hasAttribute('download')).toBe(true);
  });

  test('a deleted unread root is a tombstone rather than a blank or its previous words', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({
            data: [
              aMessage(2, {
                content: '',
                deletedAt: '2026-09-09T11:58:00.000Z',
              }),
            ],
            nextCursor: null,
          }),
        ),
    });
    expect(view.getByText('This message was deleted.')).toBeDefined();
  });

  test('asks the server for its oldest unread page', async () => {
    const asked: Parameters<Api['unreads']>[1][] = [];
    const page: MessagePage = {
      data: [
        aMessage(2, { sender: BOB, content: 'second' }),
        aMessage(3, { sender: BOB, content: 'third' }),
      ],
      nextCursor: null,
    };
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 2) })], {
      unreads: (_channel, query = {}) => {
        asked.push(query);
        return Promise.resolve(catchUp(page));
      },
    });
    expect(asked).toEqual([{ limit: UNREADS_PAGE }]);
    const words = view.getAllByText(/second|third/).map((node) => node.textContent);
    expect(words).toEqual(['second', 'third']);
    expect(view.getByText('2 new')).toBeDefined();
  });

  test('Mark read reads up to the newest shown, and no further', async () => {
    const reads: string[] = [];
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 5) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({ data: [aMessage(2, { sender: BOB })], nextCursor: messageIdAt(2) }),
        ),
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

  test('Mark read waits for its receipt and refuses a second press meanwhile', async () => {
    const receipt = Promise.withResolvers<{
      lastReadMessageId: string;
      unreadCount: number;
      unreadMentionCount: number;
    }>();
    let attempts = 0;
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(catchUp({ data: [aMessage(2, { content: 'To read' })], nextCursor: null })),
      markRead: () => {
        attempts += 1;
        return receipt.promise;
      },
    });
    const button = view.getByRole('button', { name: 'Mark read' });
    await person().click(button);
    expect(button.hasAttribute('disabled')).toBe(true);
    await person().click(button);
    expect(attempts).toBe(1);
    receipt.resolve({ lastReadMessageId: messageIdAt(2), unreadCount: 0, unreadMentionCount: 0 });
    await settle();
    expect(view.getByText('All caught up')).toBeDefined();
  });

  test('a message and its replies link directly to their own source in the named channel section', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({
            data: [
              aMessage(2, {
                content: 'Supplier delivery',
                thread: {
                  replyCount: 2,
                  lastReplyAt: '2026-09-09T11:58:00.000Z',
                  resolvedAt: null,
                  resolvedBy: null,
                },
              }),
            ],
            nextCursor: null,
          }),
        ),
    });
    const channel = within(view.getByRole('region', { name: 'api' }));
    expect(channel.getByRole('link', { name: 'Open message' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.api}?message=${messageIdAt(2)}`,
    );
    expect(
      channel.getByRole('link', { name: 'Show thread · 2 replies' }).getAttribute('href'),
    ).toBe(`/w/acme/c/${IDS.api}?thread=${messageIdAt(2)}`);
  });

  test('a refused Mark read says so', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(catchUp({ data: [aMessage(2, { sender: BOB })], nextCursor: null })),
      markRead: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
    });
    await person().click(view.getByRole('button', { name: 'Mark read' }));
    expect(await view.findByText(/It could not be marked read\./)).toBeDefined();
  });

  test('who a message really mentions is highlighted, as in the feed', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({
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
        ),
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
        unreads: () =>
          Promise.resolve(
            catchUp({
              data: [aMessage(2, { content: 'see src/a.ts:4' })],
              nextCursor: null,
            }),
          ),
      },
    );
    expect(view.container.querySelector('a[data-code-reference]')?.getAttribute('href')).toBe(
      'https://github.com/acme/api/blob/HEAD/src/a.ts#L4',
    );
  });

  test('a channel whose new messages could not be loaded says so, and Retry asks again', async () => {
    let answers = 0;
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () => {
        answers += 1;
        return answers === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              catchUp({
                data: [aMessage(2, { sender: BOB, content: 'back' })],
                nextCursor: null,
              }),
            );
      },
    });
    expect(view.getByText('What is new here could not be loaded.')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('back')).toBeDefined();
    expect(view.queryByText('What is new here could not be loaded.')).toBeNull();
  });

  test('a failed refresh cannot mark a cached message read while that message is hidden', async () => {
    let offline = false;
    const view = await visit([aChannel(IDS.api, 'api', { state: state(messageIdAt(1), 1) })], {
      unreads: () =>
        offline
          ? Promise.reject(new Error('offline'))
          : Promise.resolve(
              catchUp({
                data: [aMessage(2, { content: 'Waiting delivery update' })],
                nextCursor: null,
              }),
            ),
    });
    expect(view.getByRole('button', { name: 'Mark read' })).toBeDefined();
    offline = true;
    await act(async () => {
      await view.world.client.invalidateQueries({
        queryKey: keys.unreads(IDS.api, messageIdAt(1), 1),
      });
    });
    await settle();
    expect(view.getByText('What is new here could not be loaded.')).toBeDefined();
    expect(view.queryByText('Waiting delivery update')).toBeNull();
    expect(view.queryByRole('button', { name: 'Mark read' })).toBeNull();
    offline = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Waiting delivery update')).toBeDefined();
    expect(view.getByRole('button', { name: 'Mark read' })).toBeDefined();
  });

  test('an empty server page offers a channel-state refresh without claiming everything was read', async () => {
    let refreshed = false;
    const channels = (): Channel[] => [
      aChannel(IDS.api, 'api', { state: state(messageIdAt(9), refreshed ? 0 : 2) }),
    ];
    const view = await visit(channels(), {
      channels: () => Promise.resolve(channels()),
      unreads: () => Promise.resolve(catchUp({ data: [], nextCursor: null })),
    });
    expect(
      view.getByText('This unread list has changed. Refresh to check what is waiting.'),
    ).toBeDefined();
    expect(view.queryByText('All caught up')).toBeNull();
    expect(view.queryByRole('button', { name: 'Mark read' })).toBeNull();
    refreshed = true;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('All caught up')).toBeDefined();
  });

  test('a never-read channel preserves the server’s oldest-first page', async () => {
    const view = await visit([aChannel(IDS.api, 'api', { state: state(null, 2) })], {
      unreads: () =>
        Promise.resolve(
          catchUp({
            data: [
              aMessage(2, { sender: BOB, content: 'older' }),
              aMessage(3, { sender: BOB, content: 'newer' }),
            ],
            nextCursor: null,
          }),
        ),
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
