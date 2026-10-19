/**
 * A root's thread, the way `UX.md` §4 draws it (D-122): the line under the root that says where
 * it stands, and the panel beside the feed that it opens — the root, the replies, the box to
 * answer in, and Resolve — all through the real channel screen over an API the test wrote and a
 * socket it drives.
 *
 * What these cannot show — the panel's width beside the feed, the overlay on a narrow window,
 * whether the fold looks like a fold — is Playwright's; here the *numbers* the code assigns are
 * asserted and the geometry is stubbed where a rule depends on it.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Message, ThreadPage } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import {
  mountChannel,
  page,
  settle,
  type ChannelOptions,
  type ChannelView,
} from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  aChannel,
  aMessage,
  messageIdAt,
  someChannels,
} from '../../testing/fixtures';
import { person } from '../../testing/user';
import { ACK_DEADLINE_MS } from '../../realtime/engine';
import { expectFocusOn } from '../../testing/focus';

installDom();

const ROOT = 2;
const LAST = '2026-09-09T11:48:00.000Z';
const open = { replyCount: 2, lastReplyAt: LAST, resolvedAt: null, resolvedBy: null };
const closed = { ...open, resolvedAt: '2026-09-09T11:50:00.000Z', resolvedBy: ALICE };

const rootMessage = (over: Partial<Message> = {}): Message =>
  aMessage(ROOT, { content: 'Why is the backoff 4s?', thread: open, ...over });
const reply = (n: number, over: Partial<Message> = {}): Message =>
  aMessage(n, { parentId: messageIdAt(ROOT), thread: null, sender: BOB, ...over });
const replies = (...ns: number[]): ThreadPage => ({
  data: ns.map((n) => reply(n, { content: `answer ${String(n)}` })),
  nextCursor: null,
});

type Api = NonNullable<ChannelOptions['api']>;

const mount = async (
  options: ChannelOptions & { readonly thread?: Api['thread'] } = {},
): Promise<ChannelView> => {
  const { thread, api, ...rest } = options;
  return await mountChannel({
    messages: page([aMessage(1), rootMessage(), aMessage(5)]),
    api: {
      thread: thread ?? ((): Promise<ThreadPage> => Promise.resolve(replies(3, 4))),
      ...api,
    },
    ...rest,
  });
};

const showThread = async (view: ChannelView): Promise<void> => {
  await person().click(view.getByRole('button', { name: /Show thread/ }));
  await settle();
};

const rowOf = (view: ChannelView, id: string): HTMLElement => {
  const row = view.container.querySelector<HTMLElement>(
    `[data-message-row][data-message-id="${id}"]`,
  );
  if (row === null) throw new Error(`no row for ${id}`);
  return row;
};

const sectionOf = (view: ChannelView): HTMLElement => {
  const section = view.container.querySelector<HTMLElement>('[data-thread-root]');
  if (section === null) throw new Error('no thread is open');
  return section;
};

const rowAround = (el: HTMLElement): HTMLElement => {
  const row = el.closest<HTMLElement>('[data-message-row]');
  if (row === null) throw new Error('not inside a message row');
  return row;
};

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

const connect = (view: ChannelView): void => {
  act(() => {
    view.world.sockets.open();
  });
};

afterEach(() => {
  document.documentElement.style.removeProperty('--duration-collapse');
});

describe('a root and its thread, closed', () => {
  test('with no replies has no thread affordance at all, and a reply never has one', async () => {
    const view = await mount({
      messages: page([aMessage(1), aMessage(2, { content: 'quiet' })]),
    });
    expect(view.queryByRole('button', { name: /Show thread/ })).toBeNull();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });

  test('an open one says so, with the count and when the last reply came', async () => {
    const view = await mount();
    const line = view.getByRole('button', { name: /Show thread/ });
    expect(line.getAttribute('aria-expanded')).toBe('false');
    expect(line.textContent).toContain('Open · 2 replies · last');
    expect(within(line).getByText('T')).toBeDefined();
    // On a phone it stays one line: the status is cut, “Show thread” is never broken in two.
    const words = within(line).getByText(/Open · 2 replies/);
    expect(words.className.split(' ')).toContain('truncate');
    expect(words.parentElement?.className.split(' ')).toContain('whitespace-nowrap');
    const open = within(line).getByText('Show thread');
    expect(open.className.split(' ')).toEqual(
      expect.arrayContaining(['shrink-0', 'whitespace-nowrap']),
    );
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('a resolved one says who, and its root is quiet: dimmed, not hidden', async () => {
    const view = await mount({ messages: page([aMessage(1), rootMessage({ thread: closed })]) });
    const line = view.getByRole('button', { name: /Show thread/ });
    expect(line.textContent).toContain('Resolved by Alice · 2 replies');
    const text = within(rowOf(view, messageIdAt(ROOT))).getByText('Why is the backoff 4s?');
    expect(text.closest('.text-ink-muted')).not.toBeNull();
    expect(
      within(rowOf(view, messageIdAt(1)))
        .getByText('message 1')
        .closest('.text-ink-muted'),
    ).toBeNull();
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test("its words are the person's language", async () => {
    const view = await mount({ locale: 'tr' });
    expect(view.getByRole('button', { name: /Thread’i göster/ }).textContent).toContain(
      'Açık · 2 yanıt',
    );
    view.unmountAll();
  });
});

describe('opening it, in the panel', () => {
  test('shows the root, the replies under a count, Resolve, Close and the box to answer in, beside the feed', async () => {
    const view = await mount();
    await showThread(view);
    const panel = view.getByRole('complementary', { name: 'Thread · #api' });
    expect(panel).toBe(sectionOf(view));
    const inside = within(panel);
    expect(inside.getByText('Why is the backoff 4s?')).toBeDefined();
    expect(inside.getByText('2 replies')).toBeDefined();
    expect(inside.getByText('answer 3')).toBeDefined();
    expect(inside.getByText('answer 4')).toBeDefined();
    expect(inside.getByRole('button', { name: /Resolve/ })).toBeDefined();
    expect(inside.getByRole('button', { name: 'Close thread' })).toBeDefined();
    expect(inside.getByLabelText('Message a thread in api')).toBeDefined();
    // Beside the feed, not inside it: the root's row is marked as the one open, and its line says so.
    const row = rowOf(view, messageIdAt(ROOT));
    expect(row.contains(panel)).toBe(false);
    expect(row.hasAttribute('data-thread-open')).toBe(true);
    expect(rowOf(view, messageIdAt(1)).hasAttribute('data-thread-open')).toBe(false);
    const line = within(row).getByRole('button', { name: /Thread open/ });
    expect(line.getAttribute('aria-expanded')).toBe('true');
    expect(line.getAttribute('aria-controls')).toBe(panel.id);
    // Focus went into the panel, to its heading.
    expectFocusOn(inside.getByRole('heading', { name: 'Thread · #api' }));
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test("replies are the same rows as the feed's, grouped by the same rule, with no thread of their own", async () => {
    const view = await mount({
      thread: () => Promise.resolve(replies(3, 4)),
    });
    await showThread(view);
    const first = rowOf(view, messageIdAt(3));
    const second = rowOf(view, messageIdAt(4));
    expect(within(first).getByText('Bob')).toBeDefined();
    expect(within(second).queryByText('Bob')).toBeNull();
    expect(within(first).queryByRole('button', { name: /Show thread/ })).toBeNull();
    expect(within(first).queryByRole('button', { name: 'Reply' })).toBeNull();
    view.unmountAll();
  });

  test('while its replies load there is a skeleton under the root, never a spinner', async () => {
    let release: (page: ThreadPage) => void = () => undefined;
    const view = await mount({
      thread: () =>
        new Promise<ThreadPage>((resolve) => {
          release = resolve;
        }),
    });
    await person().click(view.getByRole('button', { name: /Show thread/ }));
    expect(
      view.getAllByRole('status').some((n) => n.textContent.includes('Loading replies…')),
    ).toBe(true);
    expect(within(sectionOf(view)).getByText('Why is the backoff 4s?')).toBeDefined();
    await expectNoAxeViolations(view.container);
    await act(async () => {
      release(replies(3));
      await Promise.resolve();
    });
    await settle();
    expect(view.getByText('answer 3')).toBeDefined();
    view.unmountAll();
  });

  test('if they fail there is a Retry right there, and the root is intact', async () => {
    let attempts = 0;
    const view = await mount({
      thread: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(replies(3, 4));
      },
    });
    await showThread(view);
    expect(view.getByRole('alert').textContent).toContain("Couldn't load replies");
    expect(within(sectionOf(view)).getByText('Why is the backoff 4s?')).toBeDefined();
    await expectNoAxeViolations(view.container);
    const retry = within(view.getByRole('alert')).getByRole('button', { name: 'Retry' });
    await person().click(retry);
    await settle();
    expect(view.queryByRole('alert')).toBeNull();
    expect(view.getByText('answer 4')).toBeDefined();
    view.unmountAll();
  });

  test('a long thread loads more on request, oldest first, newest at the bottom', async () => {
    const asked: (string | undefined)[] = [];
    const view = await mount({
      thread: (_root, query) => {
        asked.push(query?.after);
        return Promise.resolve(
          query?.after === undefined ? { ...replies(3), nextCursor: messageIdAt(3) } : replies(4),
        );
      },
    });
    await showThread(view);
    expect(view.queryByText('answer 4')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Load more replies' }));
    await settle();
    expect(asked).toEqual([undefined, messageIdAt(3)]);
    const rows = Array.from(
      view.container.querySelectorAll('[data-thread-root] [data-message-row]'),
    ).map((r) => r.getAttribute('data-message-id'));
    // The root first, at the top of the panel, then its replies.
    expect(rows).toEqual([messageIdAt(ROOT), messageIdAt(3), messageIdAt(4)]);
    expect(view.queryByRole('button', { name: 'Load more replies' })).toBeNull();
    view.unmountAll();
  });

  test('Close closes the panel, unmarks the row, and puts focus back on the root in the feed', async () => {
    const view = await mount();
    await showThread(view);
    await person().click(view.getByRole('button', { name: 'Close thread' }));
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expect(view.getByRole('button', { name: /Show thread/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    const row = rowOf(view, messageIdAt(ROOT));
    expect(row.hasAttribute('data-thread-open')).toBe(false);
    expectFocusOn(row);
    view.unmountAll();
  });

  test('one thread at a time: opening another replaces the one in the panel', async () => {
    const other = aMessage(4, { content: 'Another question?', thread: open });
    const view = await mount({ messages: page([aMessage(1), rootMessage(), other]) });
    const [first] = view.getAllByRole('button', { name: /Show thread/ });
    if (first === undefined) throw new Error('no thread line');
    await person().click(first);
    await settle();
    expect(sectionOf(view).dataset['threadRoot']).toBe(messageIdAt(ROOT));
    await person().click(view.getByRole('button', { name: /Show thread/ }));
    await settle();
    expect(view.container.querySelectorAll('[data-thread-root]')).toHaveLength(1);
    expect(sectionOf(view).dataset['threadRoot']).toBe(messageIdAt(4));
    expect(rowOf(view, messageIdAt(ROOT)).hasAttribute('data-thread-open')).toBe(false);
    view.unmountAll();
  });

  test('every thread is closed when the channel is opened again', async () => {
    const view = await mount();
    await showThread(view);
    view.unmountAll();
    const again = await mount();
    expect(again.container.querySelector('[data-thread-root]')).toBeNull();
    again.unmountAll();
  });
});

describe('replying', () => {
  test('a root nobody answered can be: Reply opens a thread that is only the box, then the first reply makes it a thread', async () => {
    const view = await mount({ messages: page([aMessage(1), aMessage(2, { content: 'quiet' })]) });
    const row = rowOf(view, messageIdAt(2));
    const reply = within(row).getByRole('button', { name: 'Reply' });
    // The same square as React beside it on every window: on a phone it once stood taller (D-150).
    expect(reply.className).toBe(
      within(row).getByRole('button', { name: 'Add reaction' }).className,
    );
    await person().click(reply);
    await settle();
    const section = view.container.querySelector<HTMLElement>('[data-thread-root]');
    if (section === null) throw new Error('the reply box did not open');
    expect(within(section).getByText('No replies yet')).toBeDefined();
    expect(within(section).queryByRole('button', { name: /Resolve/ })).toBeNull();
    const box = within(section).getByLabelText('Message a thread in api');
    expectFocusOn(box);
    await expectNoAxeViolations(view.container);
    view.unmountAll();
  });

  test('what is sent from the box goes to the socket as a reply, and is on screen as sending at once', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    const section = sectionOf(view);
    const box = within(section).getByLabelText('Message a thread in api');
    await person().type(box, 'because of the rate limit{Enter}');
    await settle();
    const sent = view.world.sockets.sent('MESSAGE_SEND').at(-1);
    expect(sent?.payload).toMatchObject({
      channelId: IDS.api,
      content: 'because of the rate limit',
      parentId: messageIdAt(ROOT),
    });
    const mine = rowAround(within(section).getByText('because of the rate limit'));
    expect(within(mine).getByLabelText('Sending')).toBeDefined();
    view.unmountAll();
  });

  test('a reply the server did not answer is failed, in the thread, with Retry and Delete like any message', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    const id = view
      .engine()
      .send({ channelId: IDS.api, content: 'no answer', parentId: messageIdAt(ROOT) });
    await settle();
    act(() => {
      view.feed.timers.advance(ACK_DEADLINE_MS);
      view.world.timers.advance(ACK_DEADLINE_MS);
    });
    await settle();
    const mine = rowOf(view, id);
    expect(within(mine).getByText('Failed to send')).toBeDefined();
    await person().click(within(mine).getByRole('button', { name: 'Delete' }));
    await settle();
    expect(view.container.querySelector(`[data-message-id="${id}"]`)).toBeNull();
    view.unmountAll();
  });

  test('a reply that is not for this root is not in this thread', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    view.engine().send({ channelId: IDS.api, content: 'elsewhere', parentId: messageIdAt(1) });
    await settle();
    expect(view.queryByText('elsewhere')).toBeNull();
    view.unmountAll();
  });
});

describe('live', () => {
  test('a thread update changes the line in place: a reply, then a resolution', async () => {
    const view = await mount();
    connect(view);
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain('2 replies');
    await arrive(view, {
      event: 'THREAD_UPDATED',
      data: {
        channelId: IDS.api,
        messageId: messageIdAt(ROOT),
        thread: { ...open, replyCount: 3 },
      },
      version: 1,
      ts: 1,
    });
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain('3 replies');
    await arrive(view, {
      event: 'THREAD_UPDATED',
      data: {
        channelId: IDS.api,
        messageId: messageIdAt(ROOT),
        thread: { ...closed, replyCount: 3 },
      },
      version: 2,
      ts: 1,
    });
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain(
      'Resolved by Alice · 3 replies',
    );
    view.unmountAll();
  });

  test('a reply that arrives while it is open joins the bottom of it, and a reaction lands on a reply', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    await arrive(view, {
      event: 'MESSAGE_CREATED',
      data: reply(6, { content: 'late answer' }),
      ts: 1,
    });
    const rows = Array.from(
      view.container.querySelectorAll('[data-thread-root] [data-message-row]'),
    ).map((r) => r.getAttribute('data-message-id'));
    expect(rows.at(-1)).toBe(messageIdAt(6));
    await arrive(view, {
      event: 'REACTIONS_UPDATED',
      data: {
        channelId: IDS.api,
        messageId: messageIdAt(6),
        reactions: [{ emoji: '👍', userIds: [ALICE.id] }],
      },
      version: 1,
      ts: 1,
    });
    expect(within(rowOf(view, messageIdAt(6))).getByRole('button', { name: /👍/u })).toBeDefined();
    view.unmountAll();
  });

  test('resolved on another device while it is open: the panel stays where the reader is, and says so', async () => {
    const animate = spyOn(HTMLElement.prototype, 'animate' as never);
    document.documentElement.style.setProperty('--duration-collapse', '120ms');
    const view = await mount();
    connect(view);
    await showThread(view);
    await arrive(view, {
      event: 'THREAD_UPDATED',
      data: { channelId: IDS.api, messageId: messageIdAt(ROOT), thread: closed },
      version: 1,
      ts: 1,
    });
    await settle();
    // Nothing here asked for it, so nothing here closes under the person reading or writing (D-122).
    const panel = sectionOf(view);
    expect(within(panel).getByText('Resolved by Alice · 2 replies')).toBeDefined();
    expect(within(panel).getByRole('button', { name: /Reopen/ })).toBeDefined();
    expect(animate).not.toHaveBeenCalled();
    animate.mockRestore();
    view.unmountAll();
  });

  test('the thread being open when its root is resolved elsewhere does not matter to a collapsed one', async () => {
    const view = await mount();
    connect(view);
    await arrive(view, {
      event: 'THREAD_UPDATED',
      data: { channelId: IDS.api, messageId: messageIdAt(ROOT), thread: closed },
      version: 1,
      ts: 1,
    });
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });
});

describe('resolving and reopening', () => {
  const resolvedRoot = (): Message => rootMessage({ thread: closed });

  test('Resolve asks the server, folds the thread, closes the panel, says so, and leaves the resolved line', async () => {
    const asked: string[] = [];
    const view = await mount({
      api: {
        resolve: (id) => {
          asked.push(id);
          return Promise.resolve(resolvedRoot());
        },
      },
    });
    await showThread(view);
    await person().click(view.getByRole('button', { name: /Resolve/ }));
    await settle();
    expect(asked).toEqual([messageIdAt(ROOT)]);
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain(
      'Resolved by Alice',
    );
    expectFocusOn(rowOf(view, messageIdAt(ROOT)));
    expect(view.getAllByRole('status').some((n) => n.textContent === 'Thread resolved')).toBe(true);
    view.unmountAll();
  });

  test("it folds with the product's one animation, on height and opacity, over the token's duration", async () => {
    const calls: { keyframes: Keyframe[]; options: KeyframeAnimationOptions }[] = [];
    const animate = spyOn(HTMLElement.prototype, 'animate' as never).mockImplementation(((
      keyframes: Keyframe[],
      options: KeyframeAnimationOptions,
    ) => {
      calls.push({ keyframes, options });
      return { finished: Promise.resolve() };
    }) as never);
    document.documentElement.style.setProperty('--duration-collapse', '120ms');
    document.documentElement.style.setProperty('--easing-standard', 'cubic-bezier(0.2, 0, 0, 1)');
    const view = await mount({ api: { resolve: () => Promise.resolve(resolvedRoot()) } });
    await showThread(view);
    await person().click(view.getByRole('button', { name: /Resolve/ }));
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.duration).toBe(120);
    expect(Object.keys(calls[0]?.keyframes[0] ?? {}).sort()).toEqual([
      'maxHeight',
      'opacity',
      'overflow',
    ]);
    expect(calls[0]?.keyframes[1]).toMatchObject({ opacity: 0 });
    animate.mockRestore();
    document.documentElement.style.removeProperty('--easing-standard');
    view.unmountAll();
  });

  test('under reduced motion the token is zero and nothing animates', async () => {
    const animate = spyOn(HTMLElement.prototype, 'animate' as never);
    document.documentElement.style.setProperty('--duration-collapse', '0ms');
    const view = await mount({ api: { resolve: () => Promise.resolve(resolvedRoot()) } });
    await showThread(view);
    await person().click(view.getByRole('button', { name: /Resolve/ }));
    await settle();
    expect(animate).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    animate.mockRestore();
    view.unmountAll();
  });

  test('a double click is one resolution', async () => {
    let calls = 0;
    let release: (m: Message) => void = () => undefined;
    const view = await mount({
      api: {
        resolve: () => {
          calls += 1;
          return new Promise<Message>((resolve) => {
            release = resolve;
          });
        },
      },
    });
    await showThread(view);
    const button = view.getByRole('button', { name: /Resolve/ });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(calls).toBe(1);
    await act(async () => {
      release(resolvedRoot());
      await Promise.resolve();
    });
    await settle();
    view.unmountAll();
  });

  test.each([
    [
      'the server says it cannot be resolved',
      new ApiError(409, 'THREAD_NOT_RESOLVABLE', 'no'),
      'Only a thread with at least one reply can be resolved.',
    ],
    [
      'anything else goes wrong',
      new ApiError(0, 'NETWORK', 'offline'),
      'The thread was not changed. Check your connection and try again.',
    ],
  ])('when %s: a toast says so in words, and nothing changes', async (_why, failure, words) => {
    const view = await mount({ api: { resolve: () => Promise.reject(failure) } });
    await showThread(view);
    await person().click(view.getByRole('button', { name: /Resolve/ }));
    await settle();
    expect(view.getByText(words)).toBeDefined();
    expect(view.container.querySelector('[data-thread-root]')).not.toBeNull();
    expect(view.getByRole('button', { name: /Resolve/ })).toBeDefined();
    view.unmountAll();
  });

  test('a resolved thread can be opened, and Reopen puts it back among the open ones', async () => {
    const view = await mount({
      messages: page([aMessage(1), resolvedRoot()]),
      api: { reopen: () => Promise.resolve(rootMessage()) },
    });
    await showThread(view);
    await person().click(view.getByRole('button', { name: /Reopen/ }));
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).not.toBeNull();
    expect(view.getAllByRole('status').some((n) => n.textContent === 'Thread reopened')).toBe(true);
    await person().click(view.getByRole('button', { name: 'Close thread' }));
    await settle();
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain(
      'Open · 2 replies',
    );
    view.unmountAll();
  });
});

describe('the keyboard (UX §7)', () => {
  const key = (el: Element, k: string, init: object = {}): void => {
    fireEvent.keyDown(el, { key: k, ...init });
  };

  test('T opens the thread of the focused message in the panel and moves focus there; Esc brings it back; R goes to the reply box', async () => {
    const view = await mount();
    const row = rowOf(view, messageIdAt(ROOT));
    act(() => {
      row.focus();
    });
    key(row, 't');
    await settle();
    const panel = sectionOf(view);
    const heading = within(panel).getByRole('heading', { name: 'Thread · #api' });
    expectFocusOn(heading);
    key(heading, 'Escape');
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expectFocusOn(row);
    key(row, 'r');
    await settle();
    expectFocusOn(view.getByLabelText('Message a thread in api'));
    view.unmountAll();
  });

  test('keys typed in a text box are text, and a root with no replies has no thread to toggle', async () => {
    const view = await mount({ messages: page([aMessage(1), aMessage(2, { content: 'quiet' })]) });
    const row = rowOf(view, messageIdAt(2));
    act(() => {
      row.focus();
    });
    key(row, 't');
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    key(row, 'r');
    await settle();
    const box = view.getByLabelText('Message a thread in api');
    key(box, 't');
    key(box, 'r');
    expectFocusOn(box);
    view.unmountAll();
  });

  test('R on a message that is still sending, or failed, opens no thread: it has none yet', async () => {
    const view = await mount();
    connect(view);
    const sending = view.engine().send({ channelId: IDS.api, content: 'on its way' });
    await settle();
    const row = rowOf(view, sending);
    act(() => {
      row.focus();
    });
    key(row, 'r');
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    act(() => {
      view.feed.timers.advance(ACK_DEADLINE_MS);
      view.world.timers.advance(ACK_DEADLINE_MS);
    });
    await settle();
    expect(within(rowOf(view, sending)).getByText('Failed to send')).toBeDefined();
    key(rowOf(view, sending), 'r');
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });

  test("modified letters are the browser's, not ours", async () => {
    const view = await mount();
    const row = rowOf(view, messageIdAt(ROOT));
    act(() => {
      row.focus();
    });
    key(row, 't', { metaKey: true });
    key(row, 't', { ctrlKey: true });
    key(row, 't', { altKey: true });
    key(row, 'r', { ctrlKey: true });
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });

  test('Cmd or Ctrl+Shift+R resolves from the focused row, and the browser keeps none of it', async () => {
    const view = await mount({
      api: { resolve: () => Promise.resolve(rootMessage({ thread: closed })) },
    });
    const row = rowOf(view, messageIdAt(ROOT));
    act(() => {
      row.focus();
    });
    const resolve = new KeyboardEvent('keydown', {
      key: 'R',
      shiftKey: true,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      row.dispatchEvent(resolve);
    });
    await settle();
    expect(resolve.defaultPrevented).toBe(true);
    expect(view.getByRole('button', { name: /Show thread/ }).textContent).toContain('Resolved by');
    view.unmountAll();
  });

  test('and reopens from inside the reply box of a resolved thread', async () => {
    let reopened = 0;
    const view = await mount({
      messages: page([aMessage(1), rootMessage({ thread: closed })]),
      api: {
        reopen: () => {
          reopened += 1;
          return Promise.resolve(rootMessage());
        },
      },
    });
    await showThread(view);
    const box = view.getByLabelText('Message a thread in api');
    // The test DOM has no `oninput`, so React watches key events on the *focused* field; a key
    // sent to one nobody focused is a failure of the DOM, not of the code under test.
    act(() => {
      box.focus();
    });
    fireEvent.keyDown(box, { key: 'r', shiftKey: true, ctrlKey: true });
    await settle();
    expect(reopened).toBe(1);
    expect(view.container.querySelector('[data-thread-root]')).not.toBeNull();
    expect(view.getAllByRole('status').some((n) => n.textContent === 'Thread reopened')).toBe(true);
    view.unmountAll();
  });

  test("Esc inside the panel closes it and puts the person back on its root; outside it, it is the feed's", async () => {
    const view = await mount();
    await showThread(view);
    const box = view.getByLabelText('Message a thread in api');
    act(() => {
      box.focus();
    });
    key(box, 'Escape');
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expectFocusOn(rowOf(view, messageIdAt(ROOT)));
    // Out of a thread: the feed's own Escape, which goes to the channel's composer.
    const other = rowOf(view, messageIdAt(1));
    act(() => {
      other.focus();
    });
    key(other, 'Escape');
    expectFocusOn(view.getByLabelText('Message api'));
    view.unmountAll();
  });

  test("Esc on the question itself closes its thread beside it, and a thread left open never takes the feed's Esc", async () => {
    const view = await mount();
    await showThread(view);
    const root = rowOf(view, messageIdAt(ROOT));
    act(() => {
      root.focus();
    });
    key(root, 'Escape');
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expectFocusOn(root);

    // With a thread open and the person on some *other* message, Esc goes to the channel's
    // composer — not to the reply box in the panel, which is in the same region.
    await showThread(view);
    const other = rowOf(view, messageIdAt(1));
    act(() => {
      other.focus();
    });
    key(other, 'Escape');
    expectFocusOn(view.getByLabelText('Message api'));
    view.unmountAll();
  });

  test('the hover Reply does what R does', async () => {
    const view = await mount();
    await person().click(
      within(rowOf(view, messageIdAt(ROOT))).getByRole('button', { name: 'Reply' }),
    );
    await settle();
    expectFocusOn(view.getByLabelText('Message a thread in api'));
    view.unmountAll();
  });
});

describe('the feed and the panel keep their places', () => {
  test('opening a thread does not move the feed: nothing is pushed, so nothing is scrolled', async () => {
    const view = await mount(); // 1000 tall in a 400 box, the reader at the bottom: 600
    expect(view.metrics.top).toBe(600);
    view.metrics.assigned.length = 0;
    await showThread(view);
    expect(view.metrics.assigned).toEqual([]);
    expect(view.metrics.top).toBe(600);
    view.unmountAll();
  });

  /** The panel's own scroller, with a height the test sets and a scroll position it reads. */
  const panelScroller = (
    view: ChannelView,
  ): { el: HTMLElement; setHeight: (h: number) => void } => {
    const el = sectionOf(view).querySelector<HTMLElement>('.overflow-y-auto');
    if (el === null) throw new Error('the panel has no scroller');
    let height = 500;
    Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => 400 });
    return {
      el,
      setHeight: (h: number): void => {
        height = h;
      },
    };
  };

  test('a reply that lands near the end of the open thread keeps the end in view', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    const { el, setHeight } = panelScroller(view);
    // A first arrival sets the height the next one is measured against.
    await arrive(view, { event: 'MESSAGE_CREATED', data: reply(6), ts: 1 });
    el.scrollTop = 100; // 500 tall in a 400 box: at the end
    setHeight(600);
    await arrive(view, { event: 'MESSAGE_CREATED', data: reply(7), ts: 1 });
    expect(el.scrollTop).toBe(200);
    view.unmountAll();
  });

  test('a reader further up the thread is not dragged down by a reply', async () => {
    const view = await mount();
    connect(view);
    await showThread(view);
    const { el, setHeight } = panelScroller(view);
    await arrive(view, { event: 'MESSAGE_CREATED', data: reply(6), ts: 1 });
    el.scrollTop = 0; // 100 above the end of a 500 box: reading the root
    setHeight(600);
    await arrive(view, { event: 'MESSAGE_CREATED', data: reply(7), ts: 1 });
    expect(el.scrollTop).toBe(0);
    view.unmountAll();
  });
});

describe('a thread asked for by the address', () => {
  test('is open when the channel opens', async () => {
    const view = await mount({ path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}` });
    expect(view.container.querySelector('[data-thread-root]')).not.toBeNull();
    expect(view.getByText('answer 3')).toBeDefined();
    view.unmountAll();
  });

  test('takes focus at once while its root is read back, and closed gives it to the main region', async () => {
    const view = await mount({
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}`,
      api: {
        messages: (_c, query) =>
          query?.before === undefined
            ? Promise.resolve(page([aMessage(9), aMessage(10)], messageIdAt(9)))
            : new Promise(() => undefined),
      },
    });
    await settle();
    const panel = view.container.querySelector<HTMLElement>('[data-thread-root]');
    // The root is still on its way: the panel has focus all the same, on its heading.
    expectFocusOn(panel?.querySelector('h2') ?? null);
    await person().click(within(panel ?? view.container).getByRole('button', { name: /^Close/ }));
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    expectFocusOn(document.getElementById('main'));
    view.unmountAll();
  });

  test('is read back to if it is older than the first page, and then brought into view', async () => {
    const scrolled: string[] = [];
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ): void {
      scrolled.push(this.getAttribute('data-message-id') ?? '');
    });
    const asked: (string | undefined)[] = [];
    const view = await mount({
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}`,
      api: {
        messages: (_c, query) => {
          asked.push(query?.before);
          return Promise.resolve(
            query?.before === undefined
              ? page([aMessage(9), aMessage(10)], messageIdAt(9))
              : page([aMessage(1), rootMessage()]),
          );
        },
      },
    });
    await settle();
    expect(asked).toEqual([undefined, messageIdAt(9)]);
    expect(scrolled).toEqual([messageIdAt(ROOT)]);
    spy.mockRestore();
    view.unmountAll();
  });

  test('once its root is brought into view, the feed lets go of the bottom: growth does not carry the reader away', async () => {
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const view = await mount({ path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}` });
    await settle();
    expect(spy).toHaveBeenCalled();
    view.metrics.scrollHeight = 1400; // older content, or a picture, grew the feed
    view.metrics.assigned.length = 0;
    view.feed.resize();
    expect(view.metrics.assigned).not.toContain(1000);
    spy.mockRestore();
    view.unmountAll();
  });

  test('and the hold ends with the next scroll: growth at the bottom is followed again', async () => {
    const spy = spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    const view = await mount({ path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}` });
    await settle();
    view.metrics.scrollHeight = 1400;
    view.feed.resize();
    view.metrics.top = 1000; // the reader went to the new bottom themselves
    fireEvent.scroll(view.scroller());
    view.metrics.scrollHeight = 1500;
    view.metrics.assigned.length = 0;
    view.feed.resize();
    expect(view.metrics.assigned).toContain(1100);
    spy.mockRestore();
    view.unmountAll();
  });

  test('an address that names nothing real opens nothing', async () => {
    const view = await mount({ path: `/w/acme/c/${IDS.api}?thread=not-an-id` });
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });

  test('a thread opened by the address takes focus, so a narrow window, where it covers the composer, keeps it', async () => {
    const view = await mount({ path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}` });
    await settle();
    const panel = sectionOf(view);
    expect(
      document.activeElement === within(panel).getByRole('heading', { name: 'Thread · #api' }),
    ).toBe(true);
    view.unmountAll();
  });

  test('a thread the whole history does not hold says so, instead of loading for ever', async () => {
    const view = await mount({
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(99)}`,
      messages: page([aMessage(1)]),
    });
    await settle();
    const panel = sectionOf(view);
    expect(within(panel).getByText('This thread is not in this channel.')).toBeDefined();
    expect(within(panel).queryByLabelText('Loading replies…')).toBeNull();
    await person().click(within(panel).getByRole('button', { name: 'Close thread' }));
    await settle();
    expect(view.container.querySelector('[data-thread-root]')).toBeNull();
    view.unmountAll();
  });

  test('a read-back that fails on its way to the root says so in the panel, and Retry finds it', async () => {
    let calls = 0;
    const view = await mount({
      path: `/w/acme/c/${IDS.api}?thread=${messageIdAt(ROOT)}`,
      messages: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(page([aMessage(5)], 'older'));
        if (calls === 2) return Promise.reject(new Error('the network went away'));
        return Promise.resolve(page([aMessage(1), rootMessage()]));
      },
    });
    await settle();
    const panel = sectionOf(view);
    const alert = within(panel).getByRole('alert');
    expect(alert.textContent).toContain("Couldn't load this thread");
    await person().click(within(alert).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(sectionOf(view)).getByText('Why is the backoff 4s?')).toBeDefined();
    view.unmountAll();
  });
});

describe('the cache is what the screen shows', () => {
  test('a thread seeded in the cache is shown without asking', async () => {
    const view = await mount({
      thread: () => Promise.reject(new Error('should not be asked')),
    });
    view.world.client.setQueryData(keys.thread(messageIdAt(ROOT)), {
      pageParams: [undefined],
      pages: [replies(3)],
    });
    await showThread(view);
    expect(view.getByText('answer 3')).toBeDefined();
    view.unmountAll();
  });
});

describe('a thread open in front of the person is read (D-147)', () => {
  /** The channels as the sidebar has them, with `api` holding what needs the person. */
  const waitingInApi = (unreadMentionCount: number): ReturnType<typeof someChannels> =>
    someChannels().map((channel) =>
      channel.id === IDS.api
        ? aChannel(IDS.api, 'api', {
            state: { lastReadMessageId: messageIdAt(5), unreadCount: 1, unreadMentionCount },
          })
        : channel,
    );

  const recording = (): {
    readonly calls: [string, string][];
    readonly readThread: (rootId: string, id: string) => Promise<void>;
  } => {
    const calls: [string, string][] = [];
    return {
      calls,
      readThread: (rootId, id): Promise<void> => {
        calls.push([rootId, id]);
        return Promise.resolve();
      },
    };
  };

  test('reads its replies up to the newest one the panel has, once', async () => {
    const reads = recording();
    const view = await mount({
      channels: waitingInApi(1),
      api: { readThread: reads.readThread },
    });
    await showThread(view);
    expect(reads.calls).toEqual([[messageIdAt(ROOT), messageIdAt(4)]]);
    view.unmountAll();
  });

  test('asks nothing when nothing in the channel needs the person', async () => {
    const reads = recording();
    const view = await mount({
      channels: waitingInApi(0),
      api: { readThread: reads.readThread },
    });
    await showThread(view);
    expect(sectionOf(view)).toBeDefined();
    expect(reads.calls).toEqual([]);
    view.unmountAll();
  });

  test('a hidden page is not reading: the thread is read when it is shown', async () => {
    const reads = recording();
    const view = await mount({
      channels: waitingInApi(1),
      api: { readThread: reads.readThread },
    });
    act(() => {
      view.feed.setPageVisible(false);
    });
    await showThread(view);
    expect(reads.calls).toEqual([]);
    act(() => {
      view.feed.setPageVisible(true);
    });
    await settle();
    expect(reads.calls).toEqual([[messageIdAt(ROOT), messageIdAt(4)]]);
    view.unmountAll();
  });

  test('a read the server refused is not asked again in a loop', async () => {
    let calls = 0;
    const view = await mount({
      channels: waitingInApi(1),
      api: {
        readThread: (): Promise<void> => {
          calls += 1;
          return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        },
      },
    });
    await showThread(view);
    await settle();
    expect(calls).toBe(1);
    view.unmountAll();
  });
});
