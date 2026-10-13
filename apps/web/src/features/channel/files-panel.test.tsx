/**
 * A channel's files, in the panel beside the conversation (D-129): opened from the header, its
 * three states (`UX.md` §8), its pages, the way back by Esc, its place shared with a thread, and
 * the frames that read it again — through the real channel screen over an API the test wrote and a
 * socket it drives.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { ChannelFile, FilePage, Message, ThreadPage } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import {
  mountChannel,
  page,
  settle,
  type ChannelOptions,
  type ChannelView,
} from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { ALICE, BOB, IDS, aMessage, messageIdAt } from '../../testing/fixtures';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';

installDom();

const fileId = (n: number): string =>
  `0199155c-${(0x7200 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`;

const aFile = (n: number, over: Partial<ChannelFile> = {}): ChannelFile => ({
  attachment: {
    id: fileId(n),
    fileName: `report-${String(n)}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    kind: 'file',
    width: null,
    height: null,
  },
  messageId: messageIdAt(n),
  parentId: null,
  sender: ALICE,
  sentAt: new Date(Date.UTC(2026, 8, 9, 8, 0, n)).toISOString(),
  ...over,
});

const filePage = (files: readonly ChannelFile[], nextCursor: string | null = null): FilePage => ({
  data: [...files],
  nextCursor,
});

type Api = NonNullable<ChannelOptions['api']>;

const mount = async (files: Api['files'], api: Api = {}): Promise<ChannelView> =>
  await mountChannel({
    messages: page([aMessage(1), aMessage(2)]),
    api: { files, ...api },
  });

const toggle = (view: ChannelView): HTMLElement =>
  view.getByRole('button', { name: 'Files in this channel' });

const openFiles = async (view: ChannelView): Promise<void> => {
  await person().click(toggle(view));
  await settle();
};

const panelOf = (view: ChannelView): HTMLElement =>
  view.getByRole('complementary', { name: /Files/ });

const arrive = async (
  view: ChannelView,
  frame: Parameters<ChannelView['world']['sockets']['deliver']>[0],
): Promise<void> => {
  await act(async () => {
    view.world.sockets.deliver(frame);
    await Promise.resolve();
  });
  await settle();
};

describe('a channel’s files panel', () => {
  test('is closed until the header opens it, and the list is not read before', async () => {
    let asked = 0;
    const view = await mount(() => {
      asked += 1;
      return Promise.resolve(filePage([]));
    });
    expect(view.queryByRole('complementary', { name: /Files/ })).toBeNull();
    expect(toggle(view).getAttribute('aria-pressed')).toBe('false');
    expect(asked).toBe(0);
    view.unmountAll();
  });

  test('loads, then lists each file with who shared it and when, its size, and a way to it', async () => {
    let answer: (page: FilePage) => void = () => undefined;
    const view = await mount(
      () =>
        new Promise<FilePage>((resolve) => {
          answer = resolve;
        }),
    );
    await openFiles(view);
    const panel = panelOf(view);
    expect(within(panel).getByRole('status').textContent).toContain('Loading files');
    expectFocusOn(within(panel).getByRole('heading', { name: /Files/ }));
    expect(toggle(view).getAttribute('aria-pressed')).toBe('true');

    await act(async () => {
      answer(filePage([aFile(2, { sender: BOB }), aFile(1)]));
      await Promise.resolve();
    });
    await settle();

    const links = within(panel).getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual(['report-2.pdf', 'report-1.pdf']);
    expect(links[0]?.getAttribute('href')).toBe(`/api/attachments/${fileId(2)}`);
    expect(links[0]?.getAttribute('download')).toBe('report-2.pdf');
    expect(links[0]?.getAttribute('aria-label')).toBe('Download report-2.pdf, 2 kB');
    const first = links[0]?.closest('li');
    expect(first?.textContent).toContain(BOB.displayName);
    expect(first?.querySelector('time')?.getAttribute('dateTime')).toBe(aFile(2).sentAt);
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('an image is opened, not downloaded, and shows its thumbnail', async () => {
    const image = aFile(3, {
      attachment: {
        ...aFile(3).attachment,
        kind: 'image',
        fileName: 'shot.webp',
        width: 4,
        height: 3,
      },
    });
    const view = await mount(() => Promise.resolve(filePage([image])));
    await openFiles(view);
    const link = within(panelOf(view)).getByRole('link', { name: 'Open shot.webp' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.hasAttribute('download')).toBe(false);
    expect(panelOf(view).querySelector('img')?.getAttribute('src')).toBe(
      `/api/attachments/${fileId(3)}/thumbnail`,
    );
    view.unmountAll();
  });

  test('says when there are none yet', async () => {
    const view = await mount(() => Promise.resolve(filePage([])));
    await openFiles(view);
    expect(within(panelOf(view)).getByRole('heading', { name: 'No files yet' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a failed read says so, and Retry reads it again', async () => {
    let calls = 0;
    const view = await mount(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve(filePage([aFile(1)]));
    });
    await openFiles(view);
    const alert = within(panelOf(view)).getByRole('alert');
    expect(alert.textContent).toContain('The files did not load.');
    await expectNoAxeViolations(view.container);

    await person().click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();

    expect(within(panelOf(view)).getByRole('link', { name: /report-1\.pdf/ })).toBeDefined();
    expect(calls).toBe(2);
    view.unmountAll();
  });

  test('reads older files from the last one shown, and says so when that fails', async () => {
    const asked: (string | undefined)[] = [];
    let older: 'ok' | 'fail' = 'fail';
    const view = await mount((_channelId, before) => {
      asked.push(before);
      if (before === undefined) return Promise.resolve(filePage([aFile(3)], fileId(3)));
      return older === 'fail'
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve(filePage([aFile(1)]));
    });
    await openFiles(view);
    const more = (): HTMLElement =>
      within(panelOf(view)).getByRole('button', { name: 'Load more' });

    await person().click(more());
    await settle();
    expect(within(panelOf(view)).getByRole('alert').textContent).toContain(
      'More files did not load.',
    );

    older = 'ok';
    await person().click(more());
    await settle();

    expect(asked).toEqual([undefined, fileId(3), fileId(3)]);
    expect(
      within(panelOf(view))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['report-3.pdf', 'report-1.pdf']);
    expect(within(panelOf(view)).queryByRole('button', { name: 'Load more' })).toBeNull();
    view.unmountAll();
  });

  test('Esc and the close control put focus back on the header’s control', async () => {
    const view = await mount(() => Promise.resolve(filePage([aFile(1)])));
    await openFiles(view);
    await person().keyboard('{Escape}');
    await settle();
    expect(view.queryByRole('complementary', { name: /Files/ })).toBeNull();
    expectFocusOn(toggle(view));

    await openFiles(view);
    await person().click(within(panelOf(view)).getByRole('button', { name: 'Close files' }));
    await settle();
    expect(view.queryByRole('complementary', { name: /Files/ })).toBeNull();
    expectFocusOn(toggle(view));
    view.unmountAll();
  });

  test('a file said in a thread opens that thread in the panel’s place', async () => {
    const root = aMessage(2, {
      thread: {
        replyCount: 1,
        lastReplyAt: aMessage(4).createdAt,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
    const reply: Message = aMessage(4, { parentId: root.id, thread: null });
    const view = await mountChannel({
      messages: page([aMessage(1), root]),
      api: {
        files: () => Promise.resolve(filePage([aFile(4, { parentId: root.id })])),
        thread: (): Promise<ThreadPage> => Promise.resolve({ data: [reply], nextCursor: null }),
      },
    });
    await openFiles(view);

    await person().click(within(panelOf(view)).getByRole('button', { name: 'Open its thread' }));
    await settle();

    expect(view.queryByRole('complementary', { name: /Files/ })).toBeNull();
    expect(view.container.querySelector(`[data-thread-root="${root.id}"]`)).not.toBeNull();
    view.unmountAll();
  });

  test('opening the files closes a thread that was open', async () => {
    const root = aMessage(2, {
      thread: {
        replyCount: 1,
        lastReplyAt: aMessage(4).createdAt,
        resolvedAt: null,
        resolvedBy: null,
      },
    });
    const view = await mountChannel({
      messages: page([aMessage(1), root]),
      api: {
        files: () => Promise.resolve(filePage([])),
        thread: (): Promise<ThreadPage> =>
          Promise.resolve({
            data: [aMessage(4, { parentId: root.id, thread: null })],
            nextCursor: null,
          }),
      },
    });
    await person().click(view.getByRole('button', { name: /Show thread/ }));
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).not.toBeNull();

    await openFiles(view);

    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expect(panelOf(view)).toBeDefined();
    view.unmountAll();
  });
});

type RevisedFrame = Extract<
  Parameters<ChannelView['world']['sockets']['deliver']>[0],
  { event: 'MESSAGE_REVISED' }
>;

describe('a channel’s files, kept current', () => {
  const counting = async (): Promise<{ view: ChannelView; asked: () => number }> => {
    let calls = 0;
    const view = await mount(() => {
      calls += 1;
      return Promise.resolve(filePage([aFile(1)]));
    });
    act(() => {
      view.world.sockets.open();
    });
    await openFiles(view);
    return { view, asked: () => calls };
  };

  test('a message arriving with files reads the list again; one without does not', async () => {
    const { view, asked } = await counting();
    expect(asked()).toBe(1);

    await arrive(view, { event: 'MESSAGE_CREATED', data: aMessage(5), ts: 1 });
    expect(asked()).toBe(1);

    await arrive(view, {
      event: 'MESSAGE_CREATED',
      data: aMessage(6, { attachments: [aFile(6).attachment] }),
      ts: 1,
    });
    expect(asked()).toBe(2);
    view.unmountAll();
  });

  test('a message deleted reads the list again; one edited does not', async () => {
    const { view, asked } = await counting();
    const revised = (version: number, deletedAt: string | null): RevisedFrame => ({
      event: 'MESSAGE_REVISED' as const,
      data: {
        channelId: IDS.api,
        messageId: messageIdAt(1),
        parentId: null,
        content: 'changed',
        editedAt: deletedAt === null ? aMessage(9).createdAt : null,
        deletedAt,
        mentions: [],
      },
      version,
      ts: 1,
    });

    await arrive(view, revised(1, null));
    expect(asked()).toBe(1);

    await arrive(view, revised(2, aMessage(9).createdAt));
    expect(asked()).toBe(2);
    view.unmountAll();
  });
});
