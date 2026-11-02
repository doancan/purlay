/**
 * Quote reply (D-213): the markdown a quote is, and a quote reaching the composer it answers in — the
 * whole message or the part selected, after what was already written, never mentioning its author.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Message } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { BOB, aMessage } from '../../testing/fixtures';
import { mountChannel, page, type ChannelView } from '../../testing/channel-harness';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';
import { composerKey, quoteMarkdown, sendToComposer } from './quote';

installDom();

describe('the markdown of a quote', () => {
  test('every line behind ">", a blank line kept as one, then whose it is and where', () => {
    expect(quoteMarkdown('first\n\nsecond', 'Bob Okafor', 'https://p.test/m')).toBe(
      '> first\n>\n> second\n> — Bob Okafor · [message](https://p.test/m)\n\n',
    );
  });

  test('names its author without mentioning them, so quoting does not notify', () => {
    expect(quoteMarkdown('hi', 'Bob Okafor', null)).not.toContain('@');
  });

  test('a long message is quoted to its start, ended at a line', () => {
    const long = Array.from({ length: 200 }, (_, n) => `line ${String(n)} of the message`).join(
      '\n',
    );
    const quoted = quoteMarkdown(long, 'Bob', null);
    expect(quoted.length).toBeLessThan(1_200);
    expect(quoted).toContain('…');
    expect(quoted).not.toContain('line 199');
  });

  test('with no composer open under the key, nothing takes it', () => {
    expect(sendToComposer(composerKey('nowhere', null), '> x')).toBe(false);
  });
});

const theirs: Message = aMessage(1, {
  sender: BOB,
  content: 'Pool size is 20 now.\nRetry after 4s.',
});

const quoteFrom = async (view: ChannelView): Promise<void> => {
  const row = view.container.querySelector<HTMLElement>(`[data-message-id="${theirs.id}"]`);
  if (row === null) throw new Error('no row');
  await person().click(within(row).getByRole('button', { name: 'More' }));
  await person().click(view.getByRole('menuitem', { name: 'Quote reply' }));
};

const box = (view: ChannelView): HTMLTextAreaElement =>
  view.getByRole('textbox', { name: /^Message/ }) as HTMLTextAreaElement;

describe('quote reply in a channel', () => {
  test('puts the whole message in the channel’s composer, the caret under it, focused', async () => {
    const view = await mountChannel({ messages: page([theirs]) });
    await quoteFrom(view);
    const value = box(view).value;
    expect(value.startsWith('> Pool size is 20 now.\n> Retry after 4s.\n> — ')).toBe(true);
    expect(value).toContain('[message](');
    expect(box(view).selectionStart).toBe(value.length);
    expectFocusOn(box(view));
    view.unmountAll();
  });

  test('keeps what was already written, and quotes only the part selected', async () => {
    const view = await mountChannel({ messages: page([theirs]) });
    await person().type(box(view), 'About this:');
    const row = view.container.querySelector<HTMLElement>(`[data-message-id="${theirs.id}"]`);
    const words = row?.querySelector('[data-message-body]');
    if (words === null || words === undefined) throw new Error('no body');
    const text = [...words.querySelectorAll('*')]
      .flatMap((element) => [...element.childNodes])
      .find(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes('Retry after 4s.'),
      );
    if (text === undefined) throw new Error('no text');
    act(() => {
      const range = document.createRange();
      range.setStart(text, text.textContent?.indexOf('Retry') ?? 0);
      range.setEnd(text, (text.textContent?.indexOf('Retry') ?? 0) + 'Retry after 4s.'.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await quoteFrom(view);
    expect(box(view).value.startsWith('About this:\n\n> Retry after 4s.\n> — ')).toBe(true);
    expect(box(view).value).not.toContain('Pool size');
    // The selection is the document's, not the view's: left behind, it would be the next test's.
    window.getSelection()?.removeAllRanges();
    view.unmountAll();
  });
});
