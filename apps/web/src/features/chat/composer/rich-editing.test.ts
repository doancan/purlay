import { describe, expect, test } from 'bun:test';
import { AllSelection, EditorState, TextSelection } from 'prosemirror-state';
import { history, undo } from 'prosemirror-history';
import { readRichDocument, richSchema, writeRichDocument } from './rich-document';
import {
  clearFormatting,
  emptyRichDraft,
  leaveCode,
  richMessageText,
  selectedLink,
  writeLink,
} from './rich-editing';

const editing = (text: string): EditorState =>
  EditorState.create({ doc: readRichDocument(text), plugins: [history()] });
const all = (state: EditorState): EditorState =>
  state.apply(state.tr.setSelection(new AllSelection(state.doc)));

describe('clear formatting', () => {
  for (const text of [
    '**bold** and _italic_ and ~~removed~~',
    '> a **quote**',
    '- **one**\n- two',
    '1. one\n2. two',
    '- [ ] one\n- [x] two',
    '> - one\n> - two',
    '# Title',
    '```js\nconst a = 1;\n```',
    '```js\n  one\n\n    two  \n```',
    '```\nhttps://example.com\n\nhello\n```',
    '```\n\none\n```',
    '```\none\n\n```',
    '```\n\n\none\n\n\n```',
    '```\n  \n  \n```',
  ]) {
    test(`retains the text and clears block and inline styling: ${text}`, () => {
      let state = all(editing(text));
      const before = state.doc.textBetween(0, state.doc.content.size, '\n', '\n');
      clearFormatting(state, (tr) => {
        state = state.apply(tr);
      });
      expect(state.doc.textBetween(0, state.doc.content.size, '\n', '\n')).toBe(before);
      expect(
        readRichDocument(writeRichDocument(state.doc).text).textBetween(
          0,
          state.doc.content.size,
          '\n',
          '\n',
        ),
      ).toBe(before);
      state.doc.descendants((node) => {
        expect(node.marks).toHaveLength(0);
        expect(['doc', 'paragraph', 'text', 'hard_break']).toContain(node.type.name);
      });
      undo(state, (tr) => {
        state = state.apply(tr);
      });
      expect(state.doc.eq(readRichDocument(text))).toBe(true);
    });
  }

  test('partial selections keep the formatting of surrounding text', () => {
    let state = editing('**abc**');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2, 3)));
    clearFormatting(state, (tr) => {
      state = state.apply(tr);
    });
    expect(writeRichDocument(state.doc).text).toBe('**a**b**c**');
  });

  test('a caret clears its own paragraph and preserves the next paragraph', () => {
    let state = editing('**first**\n\n_second_');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    clearFormatting(state, (tr) => {
      state = state.apply(tr);
    });
    expect(writeRichDocument(state.doc).text).toBe('first\n\n_second_');
    expect(state.selection.from).toBe(3);
  });

  test('table structure and cell values survive', () => {
    let state = all(editing('| **A** | B |\n|---|---|\n| one | _two_ |'));
    clearFormatting(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.firstChild?.type.name).toBe('table');
    expect(state.doc.textContent).toBe('ABonetwo');
    state.doc.descendants((node) => {
      expect(node.marks).toHaveLength(0);
    });
  });
});

describe('sending a whitespace-preserving draft', () => {
  test('whitespace in code or a link and empty link atoms remain meaningful', () => {
    for (const inline of [
      richSchema.text(' ', [richSchema.mark('code')]),
      richSchema.text(' ', [richSchema.mark('link', { href: 'https://example.com' })]),
      richSchema.node('empty_link', { href: 'https://example.com' }),
    ]) {
      const doc = richSchema.node('doc', null, [richSchema.node('paragraph', null, [inline])]);
      expect(emptyRichDraft(doc)).toBe(false);
      const source = writeRichDocument(doc).text;
      expect(richMessageText(EditorState.create({ doc }), source)).toBe(source);
    }
    const table = '| A |\n|---|\n| value |';
    expect(richMessageText(editing(table), table)).toBe(table);
  });
  test('empty lines and spaces cannot produce a blank message', () => {
    const doc = richSchema.node('doc', null, [
      richSchema.node('paragraph', null, [
        richSchema.text('  '),
        richSchema.node('hard_break'),
        richSchema.text('  '),
      ]),
    ]);
    const state = EditorState.create({ doc });
    const source = writeRichDocument(doc).text;
    expect(readRichDocument(source).eq(doc)).toBe(true);
    expect(emptyRichDraft(doc)).toBe(true);
    expect(richMessageText(state, source)).toBe('');
  });
  test('trailing blank lines and spaces are trimmed only on sending', () => {
    const doc = richSchema.node('doc', null, [
      richSchema.node('paragraph', null, [
        richSchema.text('hello '),
        richSchema.node('hard_break'),
        richSchema.node('hard_break'),
      ]),
    ]);
    const source = writeRichDocument(doc).text;
    expect(readRichDocument(source).eq(doc)).toBe(true);
    expect(richMessageText(EditorState.create({ doc }), source)).toBe('hello');
    expect(doc.textBetween(0, doc.content.size, '\n', '\n')).toBe('hello \n\n');
  });
  test('link labels and fenced code ending in a face are not rewritten', () => {
    for (const source of ['[face :D](https://example.com)', '```\n:D\n```']) {
      expect(richMessageText(editing(source), source)).toBe(source);
    }
  });
});

describe('existing links', () => {
  test('an unchanged label keeps its whitespace and styles when only the address changes', () => {
    let state = editing('[  **release** notes  ](https://example.com/old)');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 5)));
    const link = selectedLink(state);
    if (link === null) throw new Error('Expected the link at the caret');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, link.from, link.to)));
    writeLink(link.label, 'https://example.com/new')(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.textContent).toBe('  release notes  ');
    expect(state.doc.rangeHasMark(3, 10, richSchema.marks.strong)).toBe(true);
    expect(readRichDocument(writeRichDocument(state.doc).text).eq(state.doc)).toBe(true);
  });
  test('an unsafe edited address leaves the document unchanged', () => {
    const state = all(editing('[keep](https://example.com)'));
    expect(
      writeLink('keep', 'javascript:alert(1)')(state, () => {
        throw new Error('Unexpected edit');
      }),
    ).toBe(false);
  });
  test('finds the complete marked label, including runs after the caret', () => {
    let state = editing('[**release** notes](https://example.com) after');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3)));
    expect(selectedLink(state)).toEqual({
      from: 1,
      to: 14,
      label: 'release notes',
      address: 'https://example.com/',
    });
  });
  test('a mixed selection is not mistaken for one link', () => {
    expect(selectedLink(all(editing('[one](https://one.test) and two')))).toBeNull();
  });
  test('unlinking URL labels does not silently relink after serialization', () => {
    for (const value of ['https://example.com', 'www.example.com', 'test@example.com']) {
      const doc = richSchema.node('doc', null, [
        richSchema.node('paragraph', null, [richSchema.text(value)]),
      ]);
      expect(readRichDocument(writeRichDocument(doc).text).eq(doc)).toBe(true);
    }
  });
});

describe('leaving code', () => {
  test('does nothing outside code', () => {
    const state = editing('ordinary words');
    expect(
      leaveCode(state, () => {
        throw new Error('Unexpected change');
      }),
    ).toBe(false);
  });
  test('a whole selected code block can also be exited', () => {
    let state = all(editing('```\none\ntwo\n```'));
    expect(
      leaveCode(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(state.doc.firstChild?.textContent).toBe('one\ntwo');
    expect(state.selection.$from.parent.type.name).toBe('paragraph');
  });
  test('keeps every byte of code and creates a following paragraph, undoable as one action', () => {
    let state = editing('```ts\nconst x = 1;\n```');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4)));
    const original = state.doc;
    expect(
      leaveCode(state, (tr) => {
        state = state.apply(tr);
      }),
    ).toBe(true);
    expect(state.doc.firstChild?.toJSON()).toEqual(original.firstChild?.toJSON());
    expect(state.selection.$from.parent.type.name).toBe('paragraph');
    undo(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.eq(original)).toBe(true);
  });
  test('reuses an existing following paragraph without deleting its text', () => {
    let state = editing('```\nx\n```\n\nKeep me');
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1)));
    leaveCode(state, (tr) => {
      state = state.apply(tr);
    });
    expect(state.doc.childCount).toBe(2);
    expect(state.selection.$from.parent.textContent).toBe('Keep me');
    expect(state.selection.$from.parentOffset).toBe(0);
  });
});
