/** Real editor state/DOM adapter, with browser text insertion driven through its public props. */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { act, fireEvent, render } from '@testing-library/react';
import { createRef, type ComponentProps, type RefObject } from 'react';
import * as views from 'prosemirror-view';
import { AllSelection } from 'prosemirror-state';
import { baseKeymap, macBaseKeymap } from 'prosemirror-commands';
import { DOMParser, DOMSerializer } from 'prosemirror-model';
import { installDom } from '../../../testing/dom';
import { expectFocusOn } from '../../../testing/focus';
import { richSchema, readRichDocument, editorValue, writeRichDocument } from './rich-document';
import type { RichInput } from './rich-editor';
import type { MarkdownKind, Selection } from './composer-text';

const originalViews = { ...views };
const observedViews: views.EditorView[] = [];
// Observe the real view constructor rather than substituting editing, history or DOM behavior.
class ObservedView extends originalViews.EditorView {
  constructor(...args: ConstructorParameters<typeof views.EditorView>) {
    super(...args);
    observedViews.push(this);
  }
}
await mock.module('prosemirror-view', () => ({ ...originalViews, EditorView: ObservedView }));
const { RichEditor } = await import('./rich-editor');
afterAll(async () => {
  await mock.module('prosemirror-view', () => originalViews);
});
installDom();

let restoreSelectionEvents: (() => void) | undefined;
beforeEach(() => {
  // Happy DOM 21 dispatches selectionchange inside Selection.collapse(). Real browsers
  // queue one event per document, after ProseMirror finishes synchronizing the selection.
  // https://w3c.github.io/selection-api/#selectionchange-event
  const dispatch = document.dispatchEvent.bind(document);
  let pending: ReturnType<typeof setTimeout> | undefined;
  let delivering: Event | undefined;
  const intercepted = spyOn(document, 'dispatchEvent').mockImplementation((event) => {
    // Happy DOM calls dispatchEvent again with the same event during propagation.
    if (event.type !== 'selectionchange' || event === delivering) return dispatch(event);
    pending ??= setTimeout(() => {
      pending = undefined;
      delivering = event;
      try {
        dispatch(event);
      } finally {
        delivering = undefined;
      }
    }, 0);
    return true;
  });
  restoreSelectionEvents = (): void => {
    if (pending !== undefined) clearTimeout(pending);
    intercepted.mockRestore();
  };
});
afterEach(() => {
  restoreSelectionEvents?.();
  restoreSelectionEvents = undefined;
  observedViews.length = 0;
});

type Mounted = ReturnType<typeof render> & {
  readonly input: RefObject<RichInput | null>;
  readonly field: RichInput;
  readonly view: views.EditorView;
  readonly changed: string[];
  readonly selected: { selection: Selection; active: ReadonlySet<MarkdownKind> }[];
  readonly fallback: () => void;
  load(text: string, start?: number, end?: number): void;
  text(value: string): void;
  key(key: string, extra?: KeyboardEventInit): void;
  update(next: Partial<ComponentProps<typeof RichEditor>>): void;
};
const mount = (value = '', overrides: Partial<ComponentProps<typeof RichEditor>> = {}): Mounted => {
  const input = createRef<RichInput>();
  const changed: string[] = [];
  const selected: { selection: Selection; active: ReadonlySet<MarkdownKind> }[] = [];
  const fallback = mock((): void => undefined);
  const props: ComponentProps<typeof RichEditor> = {
    value,
    input,
    hidden: false,
    autoFocus: true,
    label: 'Write a message',
    description: 'hints',
    placeholder: 'Write here',
    taskLabel: 'Task',
    invalid: false,
    controls: undefined,
    activeDescendant: undefined,
    onChange: (text): void => {
      changed.push(text);
    },
    onSelect: (selection, active): void => {
      selected.push({ selection, active });
    },
    onKeyDown: (): void => undefined,
    onPaste: (): void => undefined,
    onUseSource: fallback,
    onReady: (): void => undefined,
    ...overrides,
  };
  const result = render(<RichEditor {...props} />);
  const field = editorValue(input.current);
  const view = editorValue(observedViews.at(-1));
  const load = (text: string, start = text.length, end = start): void => {
    act(() => {
      field.loadSource(text, { start, end });
    });
  };
  const text = (value: string): void => {
    act(() => {
      const { from, to } = view.state.selection;
      const handled = view.someProp('handleTextInput', (handler) =>
        handler(view, from, to, value, () => view.state.tr.insertText(value, from, to)),
      );
      if (!handled) view.dispatch(view.state.tr.insertText(value));
    });
  };
  const key = (key: string, extra: KeyboardEventInit = {}): void => {
    fireEvent.keyDown(view.dom, { key, ...extra });
  };
  const update = (next: Partial<ComponentProps<typeof RichEditor>>): void => {
    Object.assign(props, next);
    result.rerender(<RichEditor {...props} />);
  };
  return { ...result, input, field, view, changed, selected, fallback, load, text, key, update };
};
const all = ({ view }: Mounted): void => {
  act(() => {
    view.dispatch(view.state.tr.setSelection(new AllSelection(view.state.doc)));
  });
};
const mod = (): KeyboardEventInit =>
  baseKeymap === macBaseKeymap ? { metaKey: true } : { ctrlKey: true };

describe('the formatted editor adapter', () => {
  test('queues one selection notification for successive selection updates', async () => {
    const text = document.createTextNode('selection');
    document.body.append(text);
    const selection = editorValue(document.getSelection());
    const observed: number[] = [];
    const recordSelection = (): void => {
      observed.push(selection.anchorOffset);
    };
    document.addEventListener('selectionchange', recordSelection);
    try {
      selection.collapse(text, 0);
      selection.collapse(text, 3);
      expect(observed).toEqual([]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(observed).toEqual([3]);
    } finally {
      document.removeEventListener('selectionchange', recordSelection);
      text.remove();
    }
  });

  test('keeps labels, selection, focus and external source updates separate from edits', () => {
    const editor = mount('__bold__ and words');
    const { field, view } = editor;
    expect(field.value).toBe('__bold__ and words');
    expect(field.empty).toBe(false);
    expectFocusOn(field.element);
    editor.load('__bold__ and words', 2, 6);
    expect(field.selectedText).toBe('bold');
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(6);
    expect(editor.selected.at(-1)?.active.has('bold')).toBe(true);
    editor.load('__bold__ and words', 6);
    field.insertText('!');
    expect(view.dom.querySelector('strong')?.textContent).toBe('bold!');
    field.blur();
    expect(document.activeElement === field.element).toBe(false);
    field.focus();
    expectFocusOn(field.element);
    const edits = editor.changed.length;
    editor.update({
      value: 'new **draft**',
      invalid: true,
      label: 'Reply',
      controls: 'names',
      activeDescendant: 'person',
    });
    expect(field.value).toBe('new **draft**');
    expect(editor.changed).toHaveLength(edits);
    expect(view.dom.getAttribute('aria-label')).toBe('Reply');
    expect(view.dom.getAttribute('aria-invalid')).toBe('true');
    expect(view.dom.getAttribute('aria-controls')).toBe('names');
    editor.update({ hidden: true, controls: undefined, activeDescendant: undefined });
    expect(view.dom.hasAttribute('data-composer')).toBe(false);
    editor.update({ hidden: false });
    expect(view.dom.hasAttribute('data-composer')).toBe(true);
    editor.load('');
    expect(field.empty).toBe(true);
    editor.unmount();
    expect(editor.input.current).toBeNull();
  });

  for (const kind of ['bold', 'italic', 'strike', 'inlineCode'] as const) {
    test(`toggles ${kind} over a selection and at an empty caret`, () => {
      const editor = mount('one two');
      editor.load('one two', 0, 3);
      expect(editor.field.format(kind)).toBe(true);
      expect(editor.selected.at(-1)?.active.has(kind)).toBe(true);
      editor.field.clearFormatting();
      expect(editor.field.value).toBe('one two');
      editor.load('one two');
      editor.field.format(kind);
      editor.field.insertText('!');
      expect(editor.view.state.doc.lastChild?.lastChild?.marks).toHaveLength(1);
    });
  }

  test('block commands preserve words, switch list kinds and lift existing wrappers', () => {
    const editor = mount('one\n\ntwo');
    for (const kind of ['bullets', 'numbers', 'tasks'] as const) {
      editor.load('one\n\ntwo');
      all(editor);
      expect(editor.field.format(kind)).toBe(true);
      expect(editor.view.state.doc.textContent).toBe('onetwo');
      expect(editor.selected.at(-1)?.active.has(kind)).toBe(true);
      const switched = kind === 'bullets' ? 'numbers' : 'bullets';
      editor.field.format(switched);
      expect(editor.view.state.doc.textContent).toBe('onetwo');
      editor.field.format(switched);
      expect(editor.view.state.doc.firstChild?.type.name).toBe('paragraph');
    }
    editor.load('a quote');
    editor.field.format('quote');
    expect(editor.view.state.doc.firstChild?.type.name).toBe('blockquote');
    editor.field.format('quote');
    expect(editor.view.state.doc.firstChild?.type.name).toBe('paragraph');
    editor.field.format('code');
    expect(editor.field.inCode).toBe(true);
    editor.field.leaveCode();
    expect(editor.field.inCode).toBe(false);
    expect(editor.view.state.doc.firstChild?.textContent).toBe('a quote');
    for (const kind of ['table', 'link', 'mention'] as const)
      expect(editor.field.format(kind)).toBe(false);
  });

  test('tasks expose their text label and accept click, Enter and Space', () => {
    const editor = mount('- [ ] do this');
    const checkbox = editorValue(editor.view.dom.querySelector<HTMLElement>('[data-task-box]'));
    expect(checkbox.getAttribute('aria-label')).toBe('Task: do this');
    fireEvent.click(checkbox);
    expect(editor.field.value).toContain('[x]');
    fireEvent.keyDown(editorValue(editor.view.dom.querySelector('[data-task-box]')), { key: ' ' });
    expect(editor.field.value).toContain('[ ]');
    fireEvent.keyDown(editorValue(editor.view.dom.querySelector('[data-task-box]')), {
      key: 'Enter',
    });
    expect(editor.field.value).toContain('[x]');
    fireEvent.click(editor.view.dom);
    expect(editor.view.state.doc.textContent).toBe('do this');
  });

  test('editing and removing a link keeps styled text and creates a single undo step', () => {
    const editor = mount('[**label**](https://old.example)');
    editor.load('[**label**](https://old.example)', 4);
    expect(editor.field.currentLink()?.label).toBe('label');
    editor.field.insertLink('label', 'https://new.example');
    expect(editor.view.dom.querySelector('a')?.getAttribute('href')).toBe('https://new.example/');
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('label');
    editor.field.removeLink();
    expect(editor.view.dom.querySelector('a')).toBeNull();
    expect(editor.view.dom.querySelector('strong')?.textContent).toBe('label');
    editor.key('z', mod());
    expect(editor.field.currentLink()?.address).toBe('https://new.example/');
    editor.key('z', { ...mod(), shiftKey: true });
    expect(editor.field.currentLink()).toBeNull();
    editor.field.removeLink();
    editor.field.insertLink('', 'javascript:alert(1)');
    expect(editor.view.dom.querySelector('a')).toBeNull();
  });

  test('plain clipboard text never imports HTML and the composer may intercept a paste', () => {
    const paste = mock(
      (event: Parameters<ComponentProps<typeof RichEditor>['onPaste']>[0]): void => {
        expect(typeof event.currentTarget.value).toBe('string');
        if (event.clipboardData.getData('text/plain') === 'handled') event.preventDefault();
      },
    );
    const editor = mount('', { onPaste: paste });
    const data = new DataTransfer();
    data.setData('text/plain', 'one\r\ntwo');
    data.setData('text/html', '<script>alert(1)</script>');
    fireEvent.paste(editor.view.dom, { clipboardData: data });
    expect(editor.view.state.doc.textContent).toBe('one\ntwo');
    expect(editor.view.dom.querySelector('script')).toBeNull();
    data.setData('text/plain', 'handled');
    fireEvent.paste(editor.view.dom, { clipboardData: data });
    expect(editor.view.state.doc.textContent).toBe('one\ntwo');
    fireEvent.paste(editor.view.dom);
    expect(paste).toHaveBeenCalledTimes(2);
  });

  test('keyboard interception carries modifier flags and can prevent bubbling', () => {
    const key = mock(
      (event: Parameters<ComponentProps<typeof RichEditor>['onKeyDown']>[0]): void => {
        expect(event.currentTarget.value).toBe('words');
        expect(event.code).toBe('KeyQ');
        event.preventDefault();
        event.stopPropagation();
      },
    );
    const editor = mount('words', { onKeyDown: key });
    editor.key('q', { code: 'KeyQ', shiftKey: true, ctrlKey: true, altKey: true });
    expect(key).toHaveBeenCalledTimes(1);
  });

  for (const [before, next, tag] of [
    ['**word*', '*', 'strong'],
    ['*word', '*', 'em'],
    ['_word', '_', 'em'],
    ['~~word~', '~', 's'],
    ['`word', '`', 'code'],
  ] as const) {
    test(`native text input recognizes ${before + next}`, () => {
      const editor = mount();
      editor.view.dispatch(editor.view.state.tr.insertText(before));
      editor.text(next);
      expect(editor.view.dom.querySelector(tag)?.textContent).toBe('word');
      editor.key('Backspace');
      expect(editor.view.state.doc.textContent).toBe(before + next);
      expect(editor.view.dom.querySelector(tag)).toBeNull();
    });
  }

  for (const [prefix, expected] of [
    ['>', 'blockquote'],
    ['-', 'bullet_list'],
    ['3.', 'ordered_list'],
    ['```ts', 'code_block'],
    ['```', 'code_block'],
    ['##', 'heading'],
  ] as const) {
    test(`native space starts a ${expected} after ${prefix}`, () => {
      const editor = mount();
      editor.view.dispatch(editor.view.state.tr.insertText(prefix));
      editor.text(' ');
      expect(editor.view.state.doc.firstChild?.type.name).toBe(expected);
    });
  }

  test('emoticons convert on input or send, with immediate Backspace undo and code protection', () => {
    const editor = mount('hello :)');
    editor.text(' ');
    expect(editor.view.state.doc.textContent).toBe('hello 🙂 ');
    expect(editor.field.forSend()).toBe('hello 🙂');
    editor.load(':D');
    editor.field.finishFace();
    expect(editor.field.value).toBe('😄');
    editor.view.dispatch(editor.view.state.tr.setStoredMarks([]));
    editor.key('Backspace');
    expect(editor.field.value).toBe(':D');
    editor.field.finishFace();
    editor.load('different draft');
    editor.key('Backspace');
    expect(editor.field.value).toBe('different draft');
    editor.load('plain words');
    editor.field.finishFace();
    expect(editor.field.value).toBe('plain words');
    editor.load('```\n:D\n```');
    editor.field.finishFace();
    expect(editor.field.forSend()).toBe('```\n:D\n```');
    editor.load('`:D`', 2);
    editor.field.finishFace();
    expect(editor.view.state.doc.textContent).toBe(':D');
    editor.load('**hello**', 2, 7);
    editor.field.finishFace();
    expect(editor.view.state.doc.textContent).toBe('hello');
    editor.load('end :D');
    expect(editor.field.forSend()).toBe('end 😄');
    editor.load('hello');
    editor.text(' ');
    expect(editor.view.state.doc.textContent).toBe('hello ');
  });

  test('Shift+Enter preserves code, breaks paragraphs and continues after a table', () => {
    const editor = mount('line');
    editor.key('Enter', { shiftKey: true });
    expect(editor.view.state.doc.firstChild?.lastChild?.type.name).toBe('hard_break');
    editor.load('```\ncode\n```');
    editor.key('Enter', { shiftKey: true });
    expect(editor.view.state.doc.firstChild?.textContent).toBe('code\n');
    editor.load('| A | B |\n|---|---|\n| a | b |', 3);
    editor.key('Tab');
    editor.key('Tab', { shiftKey: true });
    editor.key('Enter', { shiftKey: true });
    expect(editor.view.state.doc.lastChild?.type.name).toBe('paragraph');
    editor.field.insertText('after');
    expect(editor.view.state.doc.lastChild?.textContent).toBe('after');
  });

  test('list Enter, indentation and empty-item exit keep the editing document valid', () => {
    const editor = mount('- one\n- two');
    editor.key('Tab');
    expect(editor.view.state.selection.$from.depth).toBeGreaterThan(3);
    editor.key('Tab', { shiftKey: true });
    expect(editor.view.state.selection.$from.depth).toBe(3);
    editor.key('Enter');
    expect(editor.view.state.doc.firstChild?.childCount).toBe(3);
    editor.key('Enter', { shiftKey: true });
    expect(editor.view.state.doc.lastChild?.type.name).toBe('paragraph');
    expect(readRichDocument(editor.field.value).textContent).toBe('onetwo');
  });

  test('DOM import rejects unsafe links and retains structured task/table/code content', () => {
    const editor = mount('');
    const html = document.createElement('div');
    html.innerHTML =
      '<h2>Title</h2><p><b>bold</b><i>italic</i><del>gone</del><code>code</code><br><a href="javascript:bad">unsafe</a><a href="https://example.com">safe</a><span data-empty-link="javascript:bad"></span><span data-empty-link="https://example.com"></span></p><hr><pre data-language="ts"><code>let a = 1;</code></pre><ul><li data-task><span data-task-box aria-checked="true">☑</span><div><p>done</p></div></li><li><p>normal</p></li></ul><table><tr><th style="text-align:center">A</th><td>B</td></tr></table>';
    const doc = DOMParser.fromSchema(richSchema).parse(html);
    const target = document.createElement('div');
    target.append(DOMSerializer.fromSchema(richSchema).serializeFragment(doc.content));
    expect(target.querySelector('h2')?.textContent).toBe('Title');
    expect(target.querySelectorAll('a')).toHaveLength(1);
    expect(target.querySelector('[data-empty-link]')?.getAttribute('data-empty-link')).toBe(
      'https://example.com/',
    );
    expect(target.querySelector('[data-task-box]')?.getAttribute('aria-checked')).toBe('true');
    expect(target.querySelector('pre')?.getAttribute('data-language')).toBe('ts');
    expect(writeRichDocument(doc).text).not.toContain('javascript:bad');
    editor.view.dispatch(
      editor.view.state.tr.replaceWith(0, editor.view.state.doc.content.size, doc.content),
    );
    expect(editor.view.dom.querySelector('table')).not.toBeNull();
    expect(() => editorValue(null)).toThrow('schema');
    expect(() => {
      editorValue(undefined);
    }).toThrow('schema');
  });
});
