/**
 * One message row on its own: what it draws for each state, the slots threads will use,
 * the reactions, and that it does not re-render for nothing.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { ALICE, BOB, ME, aMessage } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import * as Content from '../content/render-content';
import { MessageRow, type MessageRowProps } from './message-row';
import { QUICK_REACTIONS } from './reactions';

installDom();

const NOW = Date.UTC(2026, 8, 9, 12, 0, 0);
const members = new Map<string, string>([
  [ME.id, 'dogancan'],
  [BOB.id, 'bob'],
]);

const props = (over: Partial<MessageRowProps> = {}): MessageRowProps => ({
  message: aMessage(1, { createdAt: '2026-09-09T11:55:00.000Z' }),
  meId: ME.id,
  nowMinute: NOW,
  members,
  ...over,
});

const mount = async (
  row: MessageRowProps,
  options: Parameters<typeof renderApp>[1] = {},
): ReturnType<typeof renderApp> =>
  await renderApp(
    <>
      <Toaster dismissLabel="Close" />
      <MessageRow {...row} />
    </>,
    options,
  );

describe("a resolved thread's root", () => {
  test('is quiet — its text in the muted ink — and is the same row otherwise', async () => {
    const view = await mount(props({ dimmed: true }));
    expect(view.getByText('message 1').closest('.text-ink-muted')).not.toBeNull();
    await expectNoAxeViolations(view.container);
    const normal = await mount(props());
    expect(normal.getAllByText('message 1').at(-1)?.closest('.text-ink-muted')).toBeNull();
  });
});

describe('the avatar column', () => {
  test("a first message has the sender's avatar, hidden from a screen reader, and the time beside the name", async () => {
    const view = await mount(props({ message: aMessage(1, { sender: ALICE }) }));
    const avatar = view.container.querySelector('[aria-hidden="true"][data-avatar]');
    expect(avatar?.textContent).toBe('AL');
    expect(avatar?.className).toContain('size-avatar-lg');
    // The name is the person's display name, as the draft draws it (D-118).
    const header = view.getByText('Alice').parentElement;
    expect(header?.querySelector('time')).not.toBeNull();
  });

  test('a grouped message has no avatar and no name; its time waits in the column for the pointer', async () => {
    const view = await mount(props({ grouped: true, message: aMessage(1, { sender: ALICE }) }));
    expect(view.container.querySelector('[data-avatar]')).toBeNull();
    expect(view.queryByText('alice')).toBeNull();
    expect(view.container.querySelector('time')?.className).toContain('opacity-0');
  });

  test('a thread reply is the same row with a smaller avatar and a smaller column', async () => {
    const view = await mount(props({ compact: true, message: aMessage(1, { sender: ALICE }) }));
    const avatar = view.container.querySelector('[data-avatar]');
    expect(avatar?.className.split(' ')).toContain('size-avatar');
    expect(view.getByRole('article').firstElementChild?.className.split(' ')).toContain(
      'size-avatar',
    );
  });

  test('the row under the pointer is not tinted: the bubble is the shape, and it does not change', async () => {
    const view = await mount(props());
    const row = view.getByRole('article');
    const before = row.className;
    act(() => {
      fireEvent.pointerOver(row);
    });
    expect(row.className).toBe(before);
    expect(row.querySelector('[data-bubble]')?.className).toContain('bg-surface-200');
  });
});

describe('the two edges (D-119)', () => {
  test("somebody else's message is on the left, in a surface bubble, with an avatar and a name", async () => {
    const view = await mount(props({ message: aMessage(1, { sender: ALICE }) }));
    const row = view.getByRole('article');
    expect(row.className.split(' ')).not.toContain('flex-row-reverse');
    expect(row.dataset['outgoing']).toBeUndefined();
    expect(row.querySelector('[data-avatar]')).not.toBeNull();
    expect(view.getByText('Alice')).toBeDefined();
    expect(row.querySelector('[data-bubble]')?.className).toContain('bg-surface-200');
  });

  test('your own message is on the right, in an accent bubble, with no avatar and no name', async () => {
    const view = await mount(props({ message: aMessage(1, { sender: ME }) }));
    const row = view.getByRole('article');
    expect(row.className.split(' ')).toContain('flex-row-reverse');
    expect(row.dataset['outgoing']).toBe('');
    expect(row.querySelector('[data-avatar]')).toBeNull();
    expect(view.queryByText(ME.displayName)).toBeNull();
    expect(row.querySelector('time')).not.toBeNull();
    const bubble = row.querySelector('[data-bubble]');
    expect(bubble?.className).toContain('bg-accent-subtle');
    expect(bubble?.className).not.toContain('bg-surface-200');
    await expectNoAxeViolations(view.container);
  });

  test('your own grouped message keeps its time beside the bubble, hidden until the pointer comes', async () => {
    const view = await mount(props({ grouped: true, message: aMessage(1, { sender: ME }) }));
    const row = view.getByRole('article');
    const time = row.querySelector('time');
    expect(time?.className).toContain('opacity-0');
    act(() => {
      fireEvent.pointerOver(row);
    });
    expect(time?.className ?? '').not.toContain('opacity-0');
  });
});

describe("a repository's event (D-134)", () => {
  const event = aMessage(1, {
    sender: null,
    content: 'octocat pushed to acme/api',
    githubEvent: {
      kind: 'pull_request',
      repository: 'acme/api',
      actor: 'octocat',
      action: 'merged',
      number: 42,
      title: 'Retry with jitter',
    },
  });

  test('is GitHub’s, on the left, with the event drawn and linked from its parts', async () => {
    const view = await mount(props({ message: event }));
    const row = view.getByRole('article');
    expect(row.dataset['outgoing']).toBeUndefined();
    expect(row.dataset['editable']).toBeUndefined();
    expect(row.getAttribute('aria-label')).toContain('github');
    expect(view.getByText('GitHub')).toBeDefined();
    const sentence = view.getByRole('link', { name: 'octocat merged pull request #42' });
    expect(sentence.getAttribute('href')).toBe('https://github.com/acme/api/pull/42');
    expect(view.getByText('Retry with jitter')).toBeDefined();
    // Its words are its summary: they are not drawn beside the event.
    expect(view.queryByText('octocat pushed to acme/api')).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  test('removed, it is a tombstone like any other: the event goes with the words', async () => {
    const view = await mount(
      props({ message: { ...event, githubEvent: null, deletedAt: '2026-09-09T11:56:00.000Z' } }),
    );
    expect(view.getByText('This message was deleted.')).toBeDefined();
    expect(view.queryByRole('link', { name: /octocat/ })).toBeNull();
  });
});

describe('what a row shows', () => {
  test('the name, the time as a real element with the full time on hover, and the body', async () => {
    const view = await mount(props());
    expect(view.getByText('Alice')).toBeDefined();
    expect(view.getByText('message 1')).toBeDefined();
    const time = view.container.querySelector('time');
    expect(time?.textContent).toBe('5m ago');
    expect(time?.getAttribute('title')).toContain('2026');
    const article = view.getByRole('article');
    expect(article.getAttribute('aria-label')).toContain('alice');
    expect(article.hasAttribute('data-message-row')).toBe(true);
    expect(article.getAttribute('data-message-id')).toBe(aMessage(1).id);
  });

  test('a grouped row has no name, and its time is in the gutter, hidden until the row is hovered or focused', async () => {
    const view = await mount(props({ grouped: true }));
    expect(view.queryByText('alice')).toBeNull();
    const time = view.container.querySelector('time');
    expect(time?.className).toContain('opacity-0');
    const row = view.getByRole('article');
    act(() => {
      fireEvent.pointerOver(row);
    });
    expect(time?.className ?? '').not.toContain('opacity-0');
    act(() => {
      fireEvent.pointerLeave(row);
    });
    expect(time?.className).toContain('opacity-0');
    act(() => {
      fireEvent.focus(row);
    });
    expect(time?.className ?? '').not.toContain('opacity-0');
    act(() => {
      fireEvent.blur(row);
    });
    expect(time?.className).toContain('opacity-0');
    const first = await mount(props());
    expect(first.container.querySelector('time')?.className ?? '').not.toContain('opacity-0');
  });

  /**
   * A thread's replies are rows inside the root's row. Hovering the root must not show every
   * reply's actions (a CSS `group-hover` would), and hovering a reply must not light the root's.
   */
  test('only the nearest row answers a pointer: a nested row is its own', async () => {
    const view = await mount(
      props({
        message: aMessage(1),
        children: (
          <div data-testid="inner">
            <article data-message-row="" data-testid="reply">
              reply
            </article>
          </div>
        ),
      }),
    );
    const [root] = view.getAllByRole('article');
    if (root === undefined) throw new Error('the row did not render');
    const actions = (): HTMLElement | null =>
      root.querySelector(':scope > div > div > [data-bubble] > div.absolute');
    expect(actions()?.className).toContain('opacity-0');
    // Hidden, the actions overlap the row above and must not take its clicks.
    expect(actions()?.className).toContain('pointer-events-none');
    act(() => {
      fireEvent.pointerOver(view.getByTestId('reply'));
    });
    expect(actions()?.className).toContain('opacity-0');
    act(() => {
      fireEvent.pointerOver(root);
    });
    expect(actions()?.className ?? '').not.toContain('opacity-0');
    expect(actions()?.className ?? '').not.toContain('pointer-events-none');
  });

  test('is the one the keyboard reaches by Tab only when it is told it is', async () => {
    const reached = await mount(props({ tabIndex: 0 }));
    expect(reached.getByRole('article').tabIndex).toBe(0);
    const other = await mount(props());
    expect(other.getAllByRole('article').at(-1)?.tabIndex).toBe(-1);
  });

  test('a mention of the person fills their name, says so in words, and leaves the bubble unmarked', async () => {
    // An edge on the bubble read as a quote (owner, 2026-10-13): the name itself carries it now.
    const view = await mount(
      props({ message: aMessage(1, { mentions: [ME.id], content: 'hi @dogancan' }) }),
    );
    const bubble = view.getByRole('article').querySelector('[data-bubble]');
    expect(bubble?.className).not.toContain('border-l-marker');
    expect(bubble?.className).not.toContain('border-accent-text');
    expect(view.getByRole('article').textContent).toContain('You were mentioned');
    const name = view.getByText('@dogancan');
    expect(name.hasAttribute('data-mention-me')).toBe(true);
    expect(name.className).toContain('bg-accent');
    expect(name.className).toContain('text-on-accent');
  });

  test("somebody else's mention is highlighted in the text and does not mark the bubble", async () => {
    const view = await mount(
      props({ message: aMessage(1, { mentions: [BOB.id], content: 'ask @bob' }) }),
    );
    const bubble = view.getByRole('article').querySelector('[data-bubble]');
    expect(bubble?.className).not.toContain('border-accent-text');
    expect(view.getByText('@bob').className).toContain('text-accent-text');
    expect(view.getByText('@bob').hasAttribute('data-mention-me')).toBe(false);
  });

  test('a mention of a person the workspace does not list is plain text', async () => {
    const view = await mount(
      props({ message: aMessage(1, { mentions: [ALICE.id], content: 'ask @alice' }) }),
    );
    expect(view.container.querySelectorAll('[data-mention]')).toHaveLength(0);
  });

  test('the slots: below the content for a thread, and beside React for more actions', async () => {
    const view = await mount(
      props({
        actions: <button type="button">Reply</button>,
        children: <p>thread summary</p>,
      }),
    );
    expect(view.getByText('thread summary')).toBeDefined();
    expect(view.getByRole('button', { name: 'Reply' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Add reaction' })).toBeDefined();
  });
});

describe('a revised message', () => {
  test('an edited one says so, with when on hover, and is otherwise the same row', async () => {
    const view = await mount(
      props({
        message: aMessage(1, { content: 'better words', editedAt: '2026-09-09T11:58:00.000Z' }),
      }),
    );
    expect(view.getByText('better words')).toBeDefined();
    const note = view.getByText('edited');
    expect(note.getAttribute('title')).not.toBeNull();
    expect(view.getByRole('button', { name: 'Add reaction' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('a deleted one is its tombstone: no words, no reactions, nothing to act on, and the thread stays', async () => {
    const view = await mount(
      props({
        message: aMessage(1, {
          content: '',
          deletedAt: '2026-09-09T11:58:00.000Z',
          editedAt: '2026-09-09T11:57:00.000Z',
          reactions: [{ emoji: '👍', userIds: [BOB.id] }],
        }),
        actions: <button type="button">Reply</button>,
        children: <p>thread summary</p>,
      }),
    );
    expect(view.getByText('This message was deleted.')).toBeDefined();
    expect(view.queryByText('edited')).toBeNull();
    expect(view.queryByRole('button', { name: /👍/ })).toBeNull();
    expect(view.queryByRole('button', { name: 'Add reaction' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Reply' })).toBeNull();
    expect(view.getByText('thread summary')).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('both are said in Turkish when the interface is', async () => {
    const edited = await mount(
      props({ message: aMessage(1, { editedAt: '2026-09-09T11:58:00.000Z' }) }),
      { locale: 'tr' },
    );
    expect(edited.getByText('düzenlendi')).toBeDefined();
    edited.unmount();
    const deleted = await mount(
      props({ message: aMessage(2, { content: '', deletedAt: '2026-09-09T11:58:00.000Z' }) }),
      { locale: 'tr' },
    );
    expect(deleted.getByText('Bu mesaj silindi.')).toBeDefined();
  });
});

describe("a row of one's own outside a channel screen", () => {
  test('offers its menu, and choosing Edit there opens nothing: no screen holds an editor', async () => {
    const view = await mount(props({ message: aMessage(1, { sender: ME, content: 'mine' }) }));
    const user = person();
    await user.click(view.getByRole('button', { name: 'More' }));
    await user.click(view.getByRole('menuitem', { name: /Edit/ }));
    expect(view.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    expect(view.getByText('mine')).toBeDefined();
  });
});

describe('delivery', () => {
  test('sending is a clock in the gutter at full strength, and no actions yet', async () => {
    const view = await mount(props({ delivery: 'sending' }));
    expect(view.getByRole('img', { name: 'Sending' })).toBeDefined();
    expect(view.getByRole('article').className).not.toContain('opacity');
    expect(view.queryByRole('button', { name: 'Add reaction' })).toBeNull();
  });

  test('failed has a coloured edge and says so in words, with the reason and both ways out', async () => {
    let retried = 0;
    let discarded = 0;
    const view = await mount(
      props({
        delivery: 'failed',
        failure: 'VALIDATION_FAILED',
        onRetry: (id) => {
          retried += id === aMessage(1).id ? 1 : 0;
        },
        onDiscard: (id) => {
          discarded += id === aMessage(1).id ? 1 : 0;
        },
      }),
    );
    const bubble = view.getByRole('article').querySelector('[data-bubble]');
    expect(bubble?.className).toContain('border-danger');
    expect(bubble?.className).toContain('border-l-marker');
    expect(view.getByText('Failed to send')).toBeDefined();
    expect(view.getByText('That was refused. Check what you entered and try again.')).toBeDefined();
    const user = person();
    await user.click(view.getByRole('button', { name: 'Retry' }));
    await user.click(view.getByRole('button', { name: 'Delete' }));
    expect([retried, discarded]).toEqual([1, 1]);
    await expectNoAxeViolations(view.container);
  });

  test('failed with no reason says only what it knows', async () => {
    const view = await mount(props({ delivery: 'failed' }));
    expect(view.getByText('Failed to send')).toBeDefined();
    expect(view.container.textContent).not.toContain('was refused');
  });
});

describe('reactions', () => {
  const withReactions = aMessage(1, {
    reactions: [
      { emoji: '👍', userIds: [ME.id, BOB.id] },
      { emoji: '🎉', userIds: [BOB.id] },
    ],
  });

  test('chips say how many and whether the person is one of them, in words and in state', async () => {
    const view = await mount(props({ message: withReactions }));
    const mine = view.getByRole('button', { name: '👍, 2 reactions' });
    const theirs = view.getByRole('button', { name: '🎉, 1 reaction' });
    expect(mine.getAttribute('aria-pressed')).toBe('true');
    expect(theirs.getAttribute('aria-pressed')).toBe('false');
  });

  test('no reactions, no chips', async () => {
    const view = await mount(props());
    expect(view.container.querySelectorAll('[aria-pressed]')).toHaveLength(0);
  });

  test('a chip toggles: one that is yours is taken back, another is added', async () => {
    const calls: string[] = [];
    const view = await mount(props({ message: withReactions }), {
      api: anApi({
        react: (id, emoji) => {
          calls.push(`react ${emoji}`);
          return Promise.resolve({ reactions: [] });
        },
        unreact: (id, emoji) => {
          calls.push(`unreact ${emoji}`);
          return Promise.resolve({ reactions: [] });
        },
      }),
    });
    const user = person();
    await user.click(view.getByRole('button', { name: '👍, 2 reactions' }));
    await user.click(view.getByRole('button', { name: '🎉, 1 reaction' }));
    expect(calls).toEqual(['unreact 👍', 'react 🎉']);
  });

  test('the menu offers the quick set by name and adds the one chosen', async () => {
    const calls: string[] = [];
    const view = await mount(props(), {
      api: anApi({
        react: (_id, emoji) => {
          calls.push(emoji);
          return Promise.resolve({ reactions: [] });
        },
      }),
    });
    const user = person();
    await user.click(view.getByRole('button', { name: 'Add reaction' }));
    const items = view.getAllByRole('menuitem');
    expect(items).toHaveLength(QUICK_REACTIONS.length);
    expect(items[0]?.textContent).toContain('Thumbs up');
    await expectNoAxeViolations(view.getByRole('menu'));
    await user.click(view.getByRole('menuitem', { name: /Rocket|Ship it/ }));
    expect(calls).toEqual(['🚀']);
  });

  test('choosing an emoji that is already yours takes it back', async () => {
    const calls: string[] = [];
    const view = await mount(props({ message: withReactions }), {
      api: anApi({
        unreact: (_id, emoji) => {
          calls.push(emoji);
          return Promise.resolve({ reactions: [] });
        },
      }),
    });
    const user = person();
    await user.click(view.getByRole('button', { name: 'Add reaction' }));
    await user.click(view.getByRole('menuitem', { name: /Thumbs up/ }));
    expect(calls).toEqual(['👍']);
  });

  test('a failure is said in a toast, in the language of the page', async () => {
    const view = await mount(props({ message: withReactions }), {
      api: anApi({ react: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) }),
    });
    await person().click(view.getByRole('button', { name: '🎉, 1 reaction' }));
    expect(
      await view.findByText(
        'The reaction was not saved. Something went wrong on our side. Try again in a moment.',
      ),
    ).toBeDefined();
  });

  test('the quick set is seven distinct emoji, each with words', () => {
    expect(new Set(QUICK_REACTIONS.map((r) => r.emoji)).size).toBe(7);
    expect(QUICK_REACTIONS.every((r) => r.name.startsWith('reaction.'))).toBe(true);
  });

  test('in Turkish, the labels are Turkish', async () => {
    const view = await mount(props({ message: withReactions }), { locale: 'tr' });
    expect(view.getByRole('button', { name: '👍, 2 tepki' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Tepki ekle' })).toBeDefined();
  });
});

describe('re-rendering', () => {
  test('a row whose props did not change is not drawn again when its parent is', async () => {
    const draw = spyOn(Content, 'renderContent');
    const stable = props({ message: aMessage(1) });
    const Parent = (): React.JSX.Element => {
      const [ticks, setTicks] = useState(0);
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setTicks(ticks + 1);
            }}
          >
            tick {ticks}
          </button>
          <MessageRow {...stable} />
        </>
      );
    };
    const view = await renderApp(<Parent />);
    const first = draw.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await person().click(view.getByRole('button', { name: /tick/ }));
    expect(view.getByRole('button', { name: 'tick 1' })).toBeDefined();
    expect(draw.mock.calls.length).toBe(first);
    draw.mockRestore();
  });
});
