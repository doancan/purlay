/**
 * The questions the composer asks of its text, answered without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import {
  asCodeBlock,
  broadcastMention,
  continueList,
  enterAction,
  formatKey,
  insertMarkdown,
  insertText,
  insideFence,
  isLongPaste,
  rowsFor,
  trimEnd,
  typedWrap,
  unitsLeft,
  unitsOver,
} from './composer-text';

describe('inside a fence', () => {
  test.each([
    ['', false],
    ['hello', false],
    ['```', true],
    ['```ts', true],
    ['```ts\nconst a = 1;', true],
    ['```\ncode\n```', false],
    ['```\ncode\n```\nafter', false],
    ['```\na\n```\n```', true],
    ['not ``` at the start', false],
    ['````\nfour\n````', false],
    ['text\n```', true],
  ])('%j is %p', (before, expected) => {
    expect(insideFence(before)).toBe(expected);
  });
});

describe('addressing everybody', () => {
  test.each([
    '@here',
    '@channel',
    '@everyone',
    'hi @here',
    '@HERE',
    '@Channel now',
    'ok @here.',
    '(@here)',
    'a\n@here',
    // Not code to the engine, so prose to the server, which refuses it (#330).
    '`one\n\n@here two`',
  ])('%j is refused, and named as typed', (text) => {
    expect(broadcastMention(text)?.toLowerCase()).toMatch(/^@(here|channel|everyone)$/);
  });

  test.each([
    'hello',
    'email@here.com',
    'a@here',
    '@@here',
    '@heretic',
    '@here-team',
    '@here_x',
    '@channels',
    '`@here`',
    'use `@here` or `@channel` sparingly',
    '```\n@here\n```',
    '```\n@here',
    '@alice and @bob',
    '@hеre', // a Cyrillic е: not the word
    '@ here',
    // A link is not prose: the server reads the tree, and so does this (#330).
    '[@here](https://example.com)',
    'https://example.com/@here',
    '`x`@here',
  ])('%j is allowed', (text) => {
    expect(broadcastMention(text)).toBeNull();
  });

  test('is found after a fence has closed, and in a line next to an inline code span', () => {
    expect(broadcastMention('```\ncode\n```\n@here')).toBe('@here');
    expect(broadcastMention('`code` @here')).toBe('@here');
  });

  test('an unclosed backtick does not hide what follows it on the same line', () => {
    expect(broadcastMention('a ` @here')).toBe('@here');
  });

  test('is linear: a pathological 16,000-character input is read at once', () => {
    for (const text of [
      '`'.repeat(16_000),
      '@'.repeat(16_000),
      'a@'.repeat(8_000),
      '`a'.repeat(8_000),
      '\n'.repeat(16_000),
    ]) {
      const started = performance.now();
      broadcastMention(text);
      expect(performance.now() - started).toBeLessThan(250);
    }
  });
});

describe('the limit, counted in UTF-16 code units as the contract counts them', () => {
  test("is exactly the contract's", () => {
    expect(unitsOver('a'.repeat(MESSAGE_CONTENT_MAX))).toBe(0);
    expect(unitsOver('a'.repeat(MESSAGE_CONTENT_MAX + 1))).toBe(1);
  });

  test('a character outside the Basic Multilingual Plane counts as two', () => {
    expect(unitsOver('a'.repeat(MESSAGE_CONTENT_MAX - 1) + '😀')).toBe(1);
    expect(unitsOver('😀'.repeat(MESSAGE_CONTENT_MAX / 2))).toBe(0);
    expect(unitsOver('😀'.repeat(MESSAGE_CONTENT_MAX / 2 + 1))).toBe(2);
  });

  test('the counter is silent until it matters', () => {
    expect(unitsLeft('a'.repeat(MESSAGE_CONTENT_MAX - 501))).toBeNull();
    expect(unitsLeft('a'.repeat(MESSAGE_CONTENT_MAX - 500))).toBe(500);
    expect(unitsLeft('a'.repeat(MESSAGE_CONTENT_MAX))).toBe(0);
    expect(unitsLeft('a'.repeat(MESSAGE_CONTENT_MAX + 3))).toBe(-3);
  });
});

describe('what is sent', () => {
  test('is trimmed at the end and nowhere else', () => {
    expect(trimEnd('  a  b \n\t ')).toBe('  a  b');
    expect(trimEnd(' \n ')).toBe('');
    expect(trimEnd('a')).toBe('a');
  });
});

describe('a paste', () => {
  const lines = (n: number): string =>
    Array.from({ length: n }, (_, i) => `line ${String(i)}`).join('\n');

  test('is long past twelve lines, and not at twelve', () => {
    expect(isLongPaste(lines(12))).toBe(false);
    expect(isLongPaste(lines(13))).toBe(true);
    expect(isLongPaste('one line')).toBe(false);
    expect(isLongPaste('')).toBe(false);
  });

  test('becomes a block that holds exactly what was pasted', () => {
    expect(asCodeBlock('a\nb')).toBe('```\na\nb\n```');
    expect(asCodeBlock('a\nb\n\n')).toBe('```\na\nb\n```');
  });

  test('is fenced longer than any fence inside it, so it cannot close early', () => {
    expect(asCodeBlock('```\ninner\n```')).toBe('````\n```\ninner\n```\n````');
    expect(asCodeBlock('`````\nx')).toBe('``````\n`````\nx\n``````');
    expect(asCodeBlock('a `tick` b')).toBe('```\na `tick` b\n```');
  });
});

describe('how tall it is', () => {
  test('follows the lines, within a floor and a ceiling', () => {
    expect(rowsFor('')).toBe(2);
    expect(rowsFor('a\nb\nc')).toBe(3);
    expect(rowsFor('\n'.repeat(40))).toBe(12);
    expect(rowsFor('a', 1, 3)).toBe(1);
  });
});

describe('the three buttons under the box (D-110): markdown, inserted where the caret is', () => {
  test('bold wraps the selection, and keeps it selected', () => {
    expect(insertMarkdown('fix it', { start: 4, end: 6 }, 'bold')).toEqual({
      text: 'fix **it**',
      selection: { start: 6, end: 8 },
    });
  });

  test('bold with no selection leaves the caret between the markers', () => {
    expect(insertMarkdown('', { start: 0, end: 0 }, 'bold')).toEqual({
      text: '****',
      selection: { start: 2, end: 2 },
    });
  });

  test('code opens a fence on a line of its own, with the caret inside it', () => {
    expect(insertMarkdown('see', { start: 3, end: 3 }, 'code')).toEqual({
      text: 'see\n```\n\n```',
      selection: { start: 8, end: 8 },
    });
  });

  test('code at the start of an empty box needs no line before it', () => {
    expect(insertMarkdown('', { start: 0, end: 0 }, 'code')).toEqual({
      text: '```\n\n```',
      selection: { start: 4, end: 4 },
    });
  });

  test('code around a selection fences the selection', () => {
    expect(insertMarkdown('a\nb', { start: 0, end: 3 }, 'code')).toEqual({
      text: '```\na\nb\n```',
      selection: { start: 4, end: 7 },
    });
  });

  test('code in the middle of a line closes on a line of its own, so the rest is not swallowed', () => {
    // A closing fence with words after it is not a closing fence: everything below would be code.
    expect(insertMarkdown('see this code and more', { start: 4, end: 13 }, 'code')).toEqual({
      text: 'see \n```\nthis code\n```\n and more',
      selection: { start: 9, end: 18 },
    });
  });

  test('code before a line that already starts below adds no blank line', () => {
    expect(insertMarkdown('x\ny', { start: 1, end: 1 }, 'code')).toEqual({
      text: 'x\n```\n\n```\ny',
      selection: { start: 6, end: 6 },
    });
  });

  test('a mention starts a name after a space, so the @ is not glued to a word', () => {
    expect(insertMarkdown('hi', { start: 2, end: 2 }, 'mention')).toEqual({
      text: 'hi @',
      selection: { start: 4, end: 4 },
    });
  });

  test('a mention needs no space at the start or after one', () => {
    expect(insertMarkdown('', { start: 0, end: 0 }, 'mention')).toEqual({
      text: '@',
      selection: { start: 1, end: 1 },
    });
    expect(insertMarkdown('hi ', { start: 3, end: 3 }, 'mention')).toEqual({
      text: 'hi @',
      selection: { start: 4, end: 4 },
    });
  });

  test('text after the caret is kept, after what was inserted', () => {
    expect(insertMarkdown('ab', { start: 1, end: 1 }, 'bold')).toEqual({
      text: 'a****b',
      selection: { start: 3, end: 3 },
    });
  });
});

describe('the formatting buttons: every construct the renderer draws, as markdown (D-110, D-181)', () => {
  const at = (start: number, end = start): { start: number; end: number } => ({ start, end });

  test.each([
    ['bullets', '- '],
    ['numbers', '1. '],
    ['quote', '> '],
  ] as const)(
    '%s on a blank line with the caret in it starts the list there, caret after the marker',
    (kind, marker) => {
      expect(insertMarkdown('', at(0), kind)).toEqual({
        text: marker,
        selection: { start: marker.length, end: marker.length },
      });
      expect(insertMarkdown('title\n\nend', at(6), kind)).toEqual({
        text: `title\n${marker}\nend`,
        selection: { start: 6 + marker.length, end: 6 + marker.length },
      });
    },
  );

  test.each([
    ['italic', '_'],
    ['strike', '~~'],
    ['inlineCode', '`'],
  ] as const)('%s wraps the selection in %s and keeps it selected', (kind, mark) => {
    const wrapped = insertMarkdown('fix it', at(4, 6), kind);
    expect(wrapped).toEqual({
      text: `fix ${mark}it${mark}`,
      selection: { start: 4 + mark.length, end: 6 + mark.length },
    });
  });

  test.each([
    ['bold', '**'],
    ['italic', '_'],
    ['strike', '~~'],
    ['inlineCode', '`'],
  ] as const)('%s with nothing selected leaves the caret between its markers', (kind, mark) => {
    expect(insertMarkdown('', at(0), kind)).toEqual({
      text: `${mark}${mark}`,
      selection: { start: mark.length, end: mark.length },
    });
  });

  test.each([
    ['bold', '**'],
    ['italic', '_'],
    ['strike', '~~'],
    ['inlineCode', '`'],
  ] as const)(
    '%s again takes its markers off: with the markers inside the selection, or around it',
    (kind, mark) => {
      // The selection includes the markers.
      expect(insertMarkdown(`a ${mark}it${mark} b`, at(2, 4 + 2 * mark.length), kind)).toEqual({
        text: 'a it b',
        selection: { start: 2, end: 4 },
      });
      // The selection is what is inside them.
      expect(
        insertMarkdown(`a ${mark}it${mark} b`, at(2 + mark.length, 4 + mark.length), kind),
      ).toEqual({ text: 'a it b', selection: { start: 2, end: 4 } });
    },
  );

  test('inline code over a selection of several lines is a block, which is what it would have to be', () => {
    expect(insertMarkdown('a\nb', at(0, 3), 'inlineCode')).toEqual(
      insertMarkdown('a\nb', at(0, 3), 'code'),
    );
  });

  test('inline code around a selection that holds a backtick uses a longer run, with a space inside it', () => {
    expect(insertMarkdown('x`y', at(0, 3), 'inlineCode')).toEqual({
      text: '`` x`y ``',
      selection: { start: 3, end: 6 },
    });
  });

  test('a link around words puts the address to be typed where the caret will be taken', () => {
    expect(insertMarkdown('see docs', at(4, 8), 'link')).toEqual({
      text: 'see [docs](https://)',
      selection: { start: 11, end: 19 },
    });
  });

  test('a link over an address makes the address the target, and asks for the words', () => {
    expect(insertMarkdown('go https://purlay.test/x', at(3, 24), 'link')).toEqual({
      text: 'go [text](https://purlay.test/x)',
      selection: { start: 4, end: 8 },
    });
  });

  test('a link with nothing selected writes a template with its words selected', () => {
    expect(insertMarkdown('', at(0), 'link')).toEqual({
      text: '[text](https://)',
      selection: { start: 1, end: 5 },
    });
  });

  test('a list takes a marker on every line the selection touches, whole lines, and keeps them selected', () => {
    expect(insertMarkdown('one\ntwo\nthree', at(1, 6), 'bullets')).toEqual({
      text: '- one\n- two\nthree',
      selection: { start: 0, end: 11 },
    });
    expect(insertMarkdown('one\ntwo\nthree', at(0, 13), 'numbers')).toEqual({
      text: '1. one\n2. two\n3. three',
      selection: { start: 0, end: 22 },
    });
    expect(insertMarkdown('one\ntwo', at(0, 7), 'quote')).toEqual({
      text: '> one\n> two',
      selection: { start: 0, end: 11 },
    });
  });

  test('with no selection a list marks the line the caret is on, and the caret stays after it', () => {
    expect(insertMarkdown('a\nbb\nc', at(3), 'bullets')).toEqual({
      text: 'a\n- bb\nc',
      selection: { start: 5, end: 5 },
    });
  });

  test('the same list again takes the markers off, when every line has one', () => {
    expect(insertMarkdown('- one\n- two', at(0, 11), 'bullets')).toEqual({
      text: 'one\ntwo',
      selection: { start: 0, end: 7 },
    });
    expect(insertMarkdown('1. one\n2. two', at(0, 13), 'numbers')).toEqual({
      text: 'one\ntwo',
      selection: { start: 0, end: 7 },
    });
    expect(insertMarkdown('> one', at(0, 5), 'quote')).toEqual({
      text: 'one',
      selection: { start: 0, end: 3 },
    });
  });

  test('a selection where only some lines have the marker gets it on all of them, and none is doubled', () => {
    expect(insertMarkdown('- one\ntwo', at(0, 9), 'bullets')).toEqual({
      text: '- one\n- two',
      selection: { start: 0, end: 11 },
    });
  });
});

describe('Shift+Enter in a list or a quote carries it on (D-181)', () => {
  test('a bulleted line is followed by a bulleted line, with the caret after its marker', () => {
    expect(continueList('- one', 5)).toEqual({ text: '- one\n- ', caret: 8 });
  });

  test('a numbered line is followed by the next number, and the indent is kept', () => {
    expect(continueList('2. two', 6)).toEqual({ text: '2. two\n3. ', caret: 10 });
    expect(continueList('  - nested', 10)).toEqual({ text: '  - nested\n  - ', caret: 15 });
  });

  test('a quoted line is followed by a quoted line', () => {
    expect(continueList('> said', 6)).toEqual({ text: '> said\n> ', caret: 9 });
  });

  test('an empty item ends the list: its marker goes, and no line is added', () => {
    expect(continueList('- one\n- ', 8)).toEqual({ text: '- one\n', caret: 6 });
    expect(continueList('1. ', 3)).toEqual({ text: '', caret: 0 });
  });

  test('text after the caret moves to the new item, and a caret mid-line splits it', () => {
    expect(continueList('- ab', 3)).toEqual({ text: '- a\n- b', caret: 6 });
  });

  test('a line that is not a list is left to the browser', () => {
    expect(continueList('plain', 5)).toBeNull();
    expect(continueList('-not a list', 11)).toBeNull();
    expect(continueList('', 0)).toBeNull();
  });

  test('inside a fence nothing is carried on, since a dash in code is not a list', () => {
    expect(continueList('```\n- x', 8)).toBeNull();
  });
});

describe('which formatting a key asks for (D-181)', () => {
  const key = (
    k: string,
    over: Partial<{
      code: string;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
      getModifierState: (key: 'AltGraph') => boolean;
    }> = {},
  ): Parameters<typeof formatKey>[0] => ({
    key: k,
    code: '',
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  test.each([
    [key('b'), 'bold'],
    [key('B'), 'bold'],
    [key('i'), 'italic'],
    [key('e'), 'inlineCode'],
    [key('x', { shiftKey: true }), 'strike'],
    [key('X', { shiftKey: true }), 'strike'],
    [key('u', { shiftKey: true }), 'link'],
    [key('p', { shiftKey: true }), 'preview'],
    [key('b', { ctrlKey: false, metaKey: true }), 'bold'],
  ] as const)('%j is %s', (event, expected) => {
    expect(formatKey(event)).toBe(expected);
  });

  test.each([
    ['Digit8', 'bullets'],
    ['Digit7', 'numbers'],
    ['Digit9', 'quote'],
  ] as const)(
    'Ctrl+Shift on %s is %s, whatever character the layout makes of that key',
    (code, expected) => {
      expect(formatKey(key('*', { code, shiftKey: true }))).toBe(expected);
      expect(formatKey(key('&', { code, shiftKey: true }))).toBe(expected);
    },
  );

  test.each([
    ['without Ctrl or Meta', key('b', { ctrlKey: false })],
    ['with Alt', key('b', { altKey: true })],
    ['for a letter that means nothing', key('q')],
    ['for Shift with a letter that is not strike', key('b', { shiftKey: true })],
    ['for a digit without Shift', key('8', { code: 'Digit8' })],
    ["for Ctrl+K, which is the palette's", key('k')],
    [
      'for Alt+Shift+C without Ctrl or Meta',
      key('c', { code: 'KeyC', ctrlKey: false, altKey: true, shiftKey: true }),
    ],
    [
      'for Ctrl+Shift+C, which is the browser’s inspector',
      key('c', { code: 'KeyC', shiftKey: true }),
    ],
    ['for Ctrl+Alt+C, without Shift', key('c', { code: 'KeyC', altKey: true })],
    [
      'for Ctrl+Alt+Shift+B, a different letter',
      key('b', { code: 'KeyB', altKey: true, shiftKey: true }),
    ],
    [
      'for AltGr+Shift+C, which types a letter on some layouts',
      key('Ć', {
        code: 'KeyC',
        altKey: true,
        shiftKey: true,
        getModifierState: () => true,
      }),
    ],
  ])('nothing %s', (_name, event) => {
    expect(formatKey(event)).toBeNull();
  });

  test.each([
    ['Ctrl', key('c', { code: 'KeyC', altKey: true, shiftKey: true })],
    [
      'Meta',
      key('c', { code: 'KeyC', ctrlKey: false, metaKey: true, altKey: true, shiftKey: true }),
    ],
    // On a Mac Alt turns C into `ç`: the key is read by its position, like the digits.
    [
      'Meta, with the character Alt makes of it',
      key('ç', { code: 'KeyC', ctrlKey: false, metaKey: true, altKey: true, shiftKey: true }),
    ],
  ])('%s+Alt+Shift+C is a code block', (_name, event) => {
    expect(formatKey(event)).toBe('code');
  });
});

describe('what Enter does (D-188)', () => {
  const enter = (
    over: Partial<Parameters<typeof enterAction>[0]> = {},
  ): Parameters<typeof enterAction>[0] => ({
    key: 'Enter',
    code: 'Enter',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  test('sends, plain', () => {
    expect(enterAction(enter(), 'hello')).toBe('submit');
  });
  test('Shift+Enter is a new line, with or without a modifier beside it', () => {
    expect(enterAction(enter({ shiftKey: true }), 'hello')).toBe('newline');
    expect(enterAction(enter({ shiftKey: true, ctrlKey: true }), 'hello')).toBe('newline');
  });
  test('Ctrl+Enter and Meta+Enter send, even inside a fence', () => {
    expect(enterAction(enter({ ctrlKey: true }), '```\ncode')).toBe('submit');
    expect(enterAction(enter({ metaKey: true }), '```\ncode')).toBe('submit');
  });
  test('plain Enter inside an open fence is a new line, and after its closing one it sends', () => {
    expect(enterAction(enter(), '```ts\nlet a')).toBe('newline');
    expect(enterAction(enter(), '```ts\nlet a\n```')).toBe('submit');
  });
  test('on a device that is only touch, a plain Enter is a new line: its keyboard has no Shift+Enter, and Send is a button', () => {
    expect(enterAction(enter(), 'hello', true)).toBe('newline');
    expect(enterAction(enter({ ctrlKey: true }), 'hello', true)).toBe('submit');
    expect(enterAction(enter({ shiftKey: true }), 'hello', true)).toBe('newline');
  });
  test('any other key is not Enter', () => {
    expect(enterAction(enter({ key: 'a', code: 'KeyA' }), 'hello')).toBeNull();
  });
});

describe('a backtick typed over a selection wraps it (D-188)', () => {
  const press = (
    over: Partial<Parameters<typeof typedWrap>[0]> = {},
  ): Parameters<typeof typedWrap>[0] => ({
    key: '`',
    code: 'Backquote',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });
  const selected = { start: 2, end: 6 };
  const caret = { start: 2, end: 2 };

  test('with words selected it asks for inline code', () => {
    expect(typedWrap(press(), selected)).toBe('inlineCode');
  });
  test('with nothing selected it is only typing', () => {
    expect(typedWrap(press(), caret)).toBeNull();
  });
  test('another character is only typing', () => {
    expect(typedWrap(press({ key: 'a' }), selected)).toBeNull();
  });
  test('Ctrl or Meta with it is a shortcut of the browser’s, not ours', () => {
    expect(typedWrap(press({ metaKey: true }), selected)).toBeNull();
    expect(typedWrap(press({ ctrlKey: true }), selected)).toBeNull();
  });
  test('Ctrl+Alt is AltGr on Windows, where some layouts type a backtick', () => {
    expect(typedWrap(press({ ctrlKey: true, altKey: true }), selected)).toBe('inlineCode');
  });
});

describe('an emoji, or any text, put where the caret is (D-181)', () => {
  test('replaces the selection, and the caret waits after it', () => {
    expect(insertText('fix it now', { start: 4, end: 6 }, '😄')).toEqual({
      text: 'fix 😄 now',
      selection: { start: 6, end: 6 },
    });
  });

  test('at a point it is inserted, and counts what it is in UTF-16 units, not in characters', () => {
    const wide = insertText('ab', { start: 1, end: 1 }, '👍🏽');
    expect(wide.text).toBe('a👍🏽b');
    expect(wide.selection.start).toBe(1 + '👍🏽'.length);
  });

  test('into an empty box', () => {
    expect(insertText('', { start: 0, end: 0 }, '🚀')).toEqual({
      text: '🚀',
      selection: { start: 2, end: 2 },
    });
  });
});
