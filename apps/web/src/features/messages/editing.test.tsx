/**
 * Editing and deleting one's own message in the channel screen (D-103, `UX.md` §5 and §7): the menu,
 * the editor in the row, `E` and `↑`, the question before a delete, and what a failure leaves.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Message } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { BOB, IDS, ME, aMessage, aSession } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { expectFocusOn } from '../../testing/focus';

installDom();

const mine = aMessage(1, { sender: ME, content: 'teh deploy is at noon' });
const theirs = aMessage(2, { sender: BOB, content: 'from bob' });

const rowOf = (view: ChannelView, message: Message): HTMLElement => {
  const row = view.container.querySelector<HTMLElement>(`[data-message-id="${message.id}"]`);
  if (row === null) throw new Error(`no row for ${message.content}`);
  return row;
};

const openMenu = async (view: ChannelView, message: Message): Promise<void> => {
  await person().click(within(rowOf(view, message)).getByRole('button', { name: 'More' }));
};

const open = (view: ChannelView): void => {
  act(() => {
    view.world.sockets.open();
  });
};

/** The person as a plain member of the workspace, who moderates nothing. */
const asMember = {
  me: (): Promise<ReturnType<typeof aSession>> =>
    Promise.resolve({
      ...aSession(),
      memberships: aSession().memberships.map((m) => ({ ...m, role: 'member' as const })),
    }),
};

const items = (view: ChannelView): string[] =>
  view.getAllByRole('menuitem').map((item) => item.textContent.replace(/E$/, ''));

describe('the menu (D-150)', () => {
  test('marking and unmarking a question paints its state; a failed change is explained', async () => {
    const marked: boolean[] = [];
    const view = await mountChannel({
      messages: page([mine]),
      api: {
        ...asMember,
        setKnowledge: (_id, input) => {
          marked.push(input.isQuestion);
          if (marked.length === 3)
            return Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'Offline'));
          return Promise.resolve({
            ...mine,
            thread: {
              replyCount: 0,
              lastReplyAt: null,
              resolvedAt: null,
              resolvedBy: null,
              knowledge: { ...input, version: input.version + 1, acceptedAnswer: null },
            },
          });
        },
      },
    });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: 'Mark as a question' }));
    await settle();
    expect(view.getByText('Unanswered')).toBeDefined();
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: 'Remove question mark' }));
    await settle();
    expect(marked).toEqual([true, false]);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: 'Mark as a question' }));
    await settle();
    expect(view.getByText(/Something went wrong on our side/)).toBeDefined();
    view.unmountAll();
  });

  test("is on every message: Copy link, Copy text, Quote reply, Mark unread, Save and Pin on anybody's, Edit and Delete on one's own", async () => {
    const view = await mountChannel({ messages: page([mine, theirs]), api: asMember });
    open(view);
    await openMenu(view, mine);
    expect(items(view)).toEqual([
      'Copy link',
      'Copy text',
      'Mark as a question',
      'Forward…',
      'Quote reply',
      'Mark unread from here',
      'Save for later',
      'Pin',
      'Edit',
      'Delete',
    ]);
    await expectNoAxeViolations(view.getByRole('menu'));
    await person().keyboard('{Escape}');
    await openMenu(view, theirs);
    expect(items(view)).toEqual([
      'Copy link',
      'Copy text',
      'Mark as a question',
      'Forward…',
      'Quote reply',
      'Mark unread from here',
      'Save for later',
      'Pin',
    ]);
    view.unmountAll();
  });

  test('Copy text puts the words as written on the clipboard, and says so', async () => {
    const copied: string[] = [];
    const view = await mountChannel({
      messages: page([theirs]),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    open(view);
    await openMenu(view, theirs);
    await person().click(view.getByRole('menuitem', { name: /Copy text/ }));
    expect(copied).toEqual(['from bob']);
    expect(await view.findByText('Copied')).toBeDefined();
    view.unmountAll();
  });

  test('Copy text the browser refuses says so, and how to copy it instead', async () => {
    const view = await mountChannel({
      messages: page([theirs]),
      copy: () => Promise.reject(new Error('clipboard blocked')),
    });
    open(view);
    await openMenu(view, theirs);
    await person().click(view.getByRole('menuitem', { name: /Copy text/ }));
    expect(
      await view.findByText("Couldn't copy. Select the text and copy it yourself."),
    ).toBeDefined();
    expect(view.queryByText('Copied')).toBeNull();
    view.unmountAll();
  });

  test("an owner may delete anybody's message, and is told it is on the audit trail", async () => {
    const asked: string[] = [];
    const view = await mountChannel({
      messages: page([theirs]),
      api: {
        deleteMessage: (id) => {
          asked.push(id);
          return Promise.resolve();
        },
      },
    });
    open(view);
    await openMenu(view, theirs);
    expect(view.queryByRole('menuitem', { name: /Edit/ })).toBeNull();
    await person().click(view.getByRole('menuitem', { name: /Delete/ }));
    const dialog = await view.findByRole('dialog', { name: 'Delete this message?' });
    expect(dialog.textContent).toContain('on the audit trail');
    await person().click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(asked).toEqual([theirs.id]);
    view.unmountAll();
  });
});

describe('editing', () => {
  test('Edit opens the words in the row; Enter saves, painted before the server answers', async () => {
    const asked: string[] = [];
    let answer: (message: Message) => void = () => undefined;
    const view = await mountChannel({
      messages: page([mine]),
      api: {
        editMessage: (_id, content) => {
          asked.push(content);
          return new Promise<Message>((resolve) => {
            answer = resolve;
          });
        },
      },
    });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Edit/ }));
    const box = view.getByRole('textbox', { name: 'Edit your message' });
    expect((box as HTMLTextAreaElement).value).toBe('teh deploy is at noon');
    await expectNoAxeViolations(rowOf(view, mine));
    // Where the words are, with nothing else in between: the menu gave focus back to nobody.
    expectFocusOn(box);
    const user = person();
    await user.keyboard('{Control>}a{/Control}the deploy is at noon{Enter}');
    expect(asked).toEqual(['the deploy is at noon']);
    expect(view.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    // On screen before the answer: the words and that they were edited.
    expect(within(rowOf(view, mine)).getByText('the deploy is at noon')).toBeDefined();
    expect(within(rowOf(view, mine)).getByText('edited')).toBeDefined();
    await act(async () => {
      answer({ ...mine, content: 'the deploy is at noon', editedAt: '2026-09-09T09:00:00.000Z' });
      await Promise.resolve();
    });
    await settle();
    expect(within(rowOf(view, mine)).getByText('the deploy is at noon')).toBeDefined();
    view.unmountAll();
  });

  test('Esc lets go and nothing is asked; Shift+Enter is a new line', async () => {
    const view = await mountChannel({ messages: page([mine]) });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Edit/ }));
    const box = view.getByRole('textbox', { name: 'Edit your message' });
    const user = person();
    await user.type(box, '{Shift>}{Enter}{/Shift}more');
    expect((box as HTMLTextAreaElement).value).toBe('teh deploy is at noon\nmore');
    await user.keyboard('{Escape}');
    expect(view.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    expect(within(rowOf(view, mine)).getByText('teh deploy is at noon')).toBeDefined();
    view.unmountAll();
  });

  describe('the editor takes the composer’s keys (D-188)', () => {
    const code = aMessage(3, { sender: ME, content: '```ts\nlet a = 1;' });
    const startEditing = async (
      message: Message,
      asked: string[],
    ): Promise<{ box: HTMLTextAreaElement; view: ChannelView }> => {
      const view = await mountChannel({
        messages: page([message]),
        api: {
          editMessage: (_id, content) => {
            asked.push(content);
            return Promise.resolve({ ...message, content });
          },
        },
      });
      open(view);
      await openMenu(view, message);
      await person().click(view.getByRole('menuitem', { name: /Edit/ }));
      const box = view.getByRole('textbox', { name: 'Edit your message' });
      return { box: box as HTMLTextAreaElement, view };
    };

    test('inside an open fence Enter is a new line and saves nothing; Ctrl+Enter saves', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(code, asked);
      const user = person();
      await user.keyboard('{Enter}let b = 2;');
      expect(box.value).toBe('```ts\nlet a = 1;\nlet b = 2;');
      expect(asked).toEqual([]);
      await user.keyboard('{Control>}{Enter}{/Control}');
      expect(asked).toEqual(['```ts\nlet a = 1;\nlet b = 2;']);
      view.unmountAll();
    });

    test('a formatting key does what it does in the composer', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(mine, asked);
      act(() => {
        box.setSelectionRange(0, 3);
      });
      await person().keyboard('{Control>}b{/Control}');
      expect(box.value).toBe('**teh** deploy is at noon');
      view.unmountAll();
    });

    test('a format key leaves the selection on the words it formatted, so the next key still has them', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(mine, asked);
      act(() => {
        box.setSelectionRange(0, 3);
      });
      await person().keyboard('{Control>}b{/Control}');
      expect([box.selectionStart, box.selectionEnd]).toEqual([2, 5]);
      await person().keyboard('{Control>}b{/Control}');
      expect(box.value).toBe('teh deploy is at noon');
      view.unmountAll();
    });

    test('Shift+Enter in the middle of a list puts the caret on the new item, and an empty item ends it', async () => {
      const asked: string[] = [];
      const list = aMessage(5, { sender: ME, content: '- one\n- three' });
      const { box, view } = await startEditing(list, asked);
      act(() => {
        box.setSelectionRange(5, 5);
      });
      await person().keyboard('{Shift>}{Enter}{/Shift}two');
      expect(box.value).toBe('- one\n- two\n- three');
      await person().keyboard('{Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
      expect(box.value).toBe('- one\n- two\n\n- three');
      view.unmountAll();
    });

    test('a backtick over a selection wraps it, and the code block chord opens a fence', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(mine, asked);
      act(() => {
        box.setSelectionRange(4, 10);
      });
      fireEvent.keyDown(box, { key: '`', code: 'Backquote' });
      expect(box.value).toBe('teh `deploy` is at noon');
      const chord = new KeyboardEvent('keydown', {
        key: 'ç',
        code: 'KeyC',
        metaKey: true,
        altKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      // happy-dom answers `getModifierState('AltGraph')` with `altKey`, which no browser does.
      Object.defineProperty(chord, 'getModifierState', { value: () => false });
      act(() => {
        box.setSelectionRange(0, 3);
        box.dispatchEvent(chord);
      });
      expect(box.value.startsWith('```\nteh\n```')).toBe(true);
      expect(asked).toEqual([]);
      view.unmountAll();
    });

    test('a key that belongs to an IME composition saves nothing, and Enter after it does', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(mine, asked);
      act(() => {
        box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      });
      fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(box, { key: 'Process' });
      // Safari fires the key that ends a composition after `compositionend`: the flag still holds it.
      act(() => {
        box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      });
      fireEvent.keyDown(box, { key: 'Enter' });
      expect(asked).toEqual([]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      await person().keyboard('!{Enter}');
      expect(asked).toEqual(['teh deploy is at noon!']);
      view.unmountAll();
    });

    test('on a phone Enter is a new line, and Ctrl+Enter still saves', async () => {
      const asked: string[] = [];
      const spy = spyOn(window, 'matchMedia').mockImplementation(((query: string) => ({
        matches: query === '(pointer: coarse) and (hover: none)',
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      })) as unknown as typeof window.matchMedia);
      try {
        const { box, view } = await startEditing(mine, asked);
        await person().keyboard('{Enter}more');
        expect(box.value).toBe('teh deploy is at noon\nmore');
        expect(asked).toEqual([]);
        await person().keyboard('{Control>}{Enter}{/Control}');
        expect(asked).toEqual(['teh deploy is at noon\nmore']);
        view.unmountAll();
      } finally {
        spy.mockRestore();
      }
    });

    test('the hint names the key that saves: Enter, and Ctrl+Enter inside a fence', async () => {
      const asked: string[] = [];
      const { box, view } = await startEditing(code, asked);
      act(() => {
        box.setSelectionRange(box.value.length, box.value.length);
        fireEvent.select(box);
      });
      expect(view.getByText(/Ctrl\+Enter to save/)).toBeDefined();
      act(() => {
        box.setSelectionRange(0, 0);
        fireEvent.select(box);
      });
      expect(view.getByText(/^Enter to save/)).toBeDefined();
      view.unmountAll();
    });

    test('Shift+Enter in a list carries it on', async () => {
      const asked: string[] = [];
      const list = aMessage(4, { sender: ME, content: '- one' });
      const { box, view } = await startEditing(list, asked);
      await person().keyboard('{Shift>}{Enter}{/Shift}two');
      expect(box.value).toBe('- one\n- two');
      view.unmountAll();
    });
  });

  test('refused, the old words come back, the toast says why, and the editor opens on the draft', async () => {
    const view = await mountChannel({
      messages: page([mine]),
      api: { editMessage: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Edit/ }));
    const user = person();
    await user.keyboard('{Control>}a{/Control}kept words{Enter}');
    expect(await view.findByText(/Your edit was not saved\./)).toBeDefined();
    await settle();
    const again = view.getByRole('textbox', { name: 'Edit your message' });
    expect((again as HTMLTextAreaElement).value).toBe('kept words');
    view.unmountAll();
  });

  test('E on a focused message of one’s own opens the editor; on somebody else’s it does nothing', async () => {
    const view = await mountChannel({ messages: page([mine, theirs]) });
    open(view);
    act(() => {
      rowOf(view, theirs).focus();
    });
    fireEvent.keyDown(rowOf(view, theirs), { key: 'e' });
    expect(view.queryByRole('textbox', { name: 'Edit your message' })).toBeNull();
    act(() => {
      rowOf(view, mine).focus();
    });
    fireEvent.keyDown(rowOf(view, mine), { key: 'e' });
    expect(view.getByRole('textbox', { name: 'Edit your message' })).toBeDefined();
    view.unmountAll();
  });

  test('↑ in an empty composer edits the newest message of one’s own', async () => {
    const newest = aMessage(4, { sender: ME, content: 'the newest of mine' });
    const view = await mountChannel({ messages: page([mine, theirs, newest]) });
    open(view);
    const composer = view.getByRole('textbox', { name: /Message/ });
    act(() => {
      composer.focus();
    });
    fireEvent.keyDown(composer, { key: 'ArrowUp' });
    const box = view.getByRole('textbox', { name: 'Edit your message' });
    expect((box as HTMLTextAreaElement).value).toBe('the newest of mine');
    view.unmountAll();
  });
});

describe('deleting', () => {
  test('is asked first; Cancel keeps it, Delete takes it away', async () => {
    const asked: string[] = [];
    const view = await mountChannel({
      messages: page([mine, theirs]),
      api: {
        deleteMessage: (id) => {
          asked.push(id);
          return Promise.resolve();
        },
      },
    });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Delete/ }));
    const dialog = view.getByRole('dialog', { name: 'Delete this message?' });
    await expectNoAxeViolations(dialog);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(asked).toEqual([]);
    expect(within(rowOf(view, mine)).getByText('teh deploy is at noon')).toBeDefined();

    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Delete/ }));
    await person().click(
      within(view.getByRole('dialog', { name: 'Delete this message?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await settle();
    expect(asked).toEqual([mine.id]);
    expect(view.container.querySelector(`[data-message-id="${mine.id}"]`)).toBeNull();
    expect(view.getByText('from bob')).toBeDefined();
    view.unmountAll();
  });

  test('refused, the toast says so', async () => {
    const view = await mountChannel({
      messages: page([mine]),
      api: { deleteMessage: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')) },
    });
    open(view);
    await openMenu(view, mine);
    await person().click(view.getByRole('menuitem', { name: /Delete/ }));
    await person().click(
      within(view.getByRole('dialog', { name: 'Delete this message?' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    expect(await view.findByText(/The message was not deleted\./)).toBeDefined();
    view.unmountAll();
  });

  test('is asked in Turkish when the interface is', async () => {
    const view = await mountChannel({ messages: page([mine]), locale: 'tr' });
    open(view);
    await person().click(within(rowOf(view, mine)).getByRole('button', { name: 'Daha fazla' }));
    await person().click(view.getByRole('menuitem', { name: /Sil/ }));
    expect(view.getByRole('dialog', { name: 'Bu mesaj silinsin mi?' })).toBeDefined();
    view.unmountAll();
  });
});

describe('forwarding (D-217)', () => {
  test('sends the link on to the channel chosen, after the note, and says so', async () => {
    const view = await mountChannel({ messages: page([theirs]), api: asMember });
    open(view);
    await openMenu(view, theirs);
    await person().click(view.getByRole('menuitem', { name: 'Forward…' }));
    const dialog = within(view.getByRole('dialog', { name: 'Forward message' }));
    const send = dialog.getByRole('button', { name: 'Forward' });
    expect(send.hasAttribute('disabled')).toBe(true);
    await person().type(
      dialog.getByRole('searchbox', { name: 'Find a channel or a person' }),
      'dep',
    );
    await person().click(dialog.getByRole('radio', { name: /deploys/ }));
    await person().type(dialog.getByRole('textbox', { name: 'Add a note (optional)' }), 'FYI');
    await person().click(send);
    const frames = view.world.sockets
      .sent('MESSAGE_SEND')
      .map((frame) => frame.payload as { channelId: string; content: string });
    expect(frames.at(-1)?.channelId).toBe(IDS.deploys);
    expect(frames.at(-1)?.content).toBe(
      `FYI\n\n${window.location.origin}/w/acme/c/${IDS.api}?message=${theirs.id}`,
    );
    expect(view.getByText('Forwarded')).toBeDefined();
    view.unmountAll();
  });
});
