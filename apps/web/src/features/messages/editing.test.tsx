/**
 * Editing and deleting one's own message in the channel screen (D-103, `UX.md` §5 and §7): the menu,
 * the editor in the row, `E` and `↑`, the question before a delete, and what a failure leaves.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { Message } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { BOB, ME, aMessage } from '../../testing/fixtures';
import { person } from '../../testing/user';

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

describe('the menu', () => {
  test("is on one's own message and not on anybody else's", async () => {
    const view = await mountChannel({ messages: page([mine, theirs]) });
    open(view);
    expect(within(rowOf(view, mine)).getByRole('button', { name: 'More' })).toBeDefined();
    expect(within(rowOf(view, theirs)).queryByRole('button', { name: 'More' })).toBeNull();
    await openMenu(view, mine);
    expect(view.getByRole('menuitem', { name: /Edit/ })).toBeDefined();
    expect(view.getByRole('menuitem', { name: /Delete/ })).toBeDefined();
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
    expect(document.activeElement).toBe(box);
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
