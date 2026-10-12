/**
 * The questions the composer asks of its text, answered without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import {
  asCodeBlock,
  broadcastMention,
  insertMarkdown,
  insideFence,
  isLongPaste,
  rowsFor,
  trimEnd,
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
