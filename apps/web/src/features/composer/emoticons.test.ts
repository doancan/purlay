/**
 * Typed faces and the emoji they become (D-253), answered without a DOM.
 */
import { describe, expect, test } from 'bun:test';
import { EMOTICONS, emoticonEndingAt, typedAfterFace, withClosingEmoji } from './emoticons';

/** `before` with `typed` put in at `at`, and where the caret is after it. */
const typing = (before: string, at: number, typed: string): [string, number] => [
  before.slice(0, at) + typed + before.slice(at),
  at + typed.length,
];

describe('which faces', () => {
  test('every face is a few characters with no space in it, and every one becomes an emoji', () => {
    for (const [typed, emoji] of EMOTICONS) {
      expect(typed.length).toBeGreaterThanOrEqual(2);
      expect(typed.length).toBeLessThanOrEqual(4);
      expect(typed).not.toMatch(/\s/);
      expect(emoji).not.toMatch(/[\x20-\x7e]/);
    }
  });

  test('the common ones', () => {
    expect(EMOTICONS.get(':)')).toBe('🙂');
    expect(EMOTICONS.get(':D')).toBe('😄');
    expect(EMOTICONS.get(';)')).toBe('😉');
    expect(EMOTICONS.get(':(')).toBe('🙁');
    expect(EMOTICONS.get('<3')).toBe('❤️');
    expect(EMOTICONS.get('xD')).toBe('😆');
  });
});

describe('a face that ends at a point', () => {
  test('alone, at the start or after a space or a new line', () => {
    expect(emoticonEndingAt(':D', 2)).toEqual({ start: 0, end: 2, typed: ':D', emoji: '😄' });
    expect(emoticonEndingAt('ok :D', 5)?.start).toBe(3);
    expect(emoticonEndingAt('ok\n:-)', 6)?.emoji).toBe('🙂');
    expect(emoticonEndingAt('ok\t<3', 5)?.emoji).toBe('❤️');
  });

  test('not part of a word or an address', () => {
    expect(emoticonEndingAt('a:D', 3)).toBeNull();
    expect(emoticonEndingAt('http://a.b:D', 12)).toBeNull();
    expect(emoticonEndingAt('(:D', 3)).toBeNull();
    expect(emoticonEndingAt(':Dosya', 6)).toBeNull();
    expect(emoticonEndingAt(':Dosya', 2)?.typed).toBe(':D');
  });

  test('case is kept: :d and xd are not faces', () => {
    expect(emoticonEndingAt(':d', 2)).toBeNull();
    expect(emoticonEndingAt('xd', 2)).toBeNull();
  });

  test('a long word is not a face, however it ends', () => {
    expect(emoticonEndingAt(`${'a'.repeat(10_000)}:D`, 10_002)).toBeNull();
  });

  test('never inside code: inline, or an open fence', () => {
    expect(emoticonEndingAt('see `a :)', 9)).toBeNull();
    expect(emoticonEndingAt('see `a` :)', 10)?.emoji).toBe('🙂');
    expect(emoticonEndingAt('```\nif (x) :)', 13)).toBeNull();
    expect(emoticonEndingAt('```\ncode\n```\n:)', 15)?.emoji).toBe('🙂');
    // Backticks on an earlier line do not reach this one.
    expect(emoticonEndingAt('one `a\n:)', 9)?.emoji).toBe('🙂');
  });
});

describe('the keystroke after a face', () => {
  test('a space after a face makes it an emoji and the caret follows', () => {
    const [after, caret] = typing('hi :D', 5, ' ');
    expect(typedAfterFace('hi :D', after, caret)).toEqual({
      face: { start: 3, end: 5, typed: ':D', emoji: '😄' },
      text: 'hi 😄 ',
      caret: 3 + '😄'.length + 1,
    });
  });

  test('a new line does too, and so does a space in the middle of the text', () => {
    const [after, caret] = typing(':)', 2, '\n');
    expect(typedAfterFace(':)', after, caret)?.text).toBe('🙂\n');
    const [middle, at] = typing('a :( b', 4, ' ');
    expect(typedAfterFace('a :( b', middle, at)?.text).toBe('a 🙁  b');
  });

  test('a letter, a deletion, a paste or a space after a word does nothing', () => {
    expect(typedAfterFace(':D', ':Do', 3)).toBeNull();
    expect(typedAfterFace(':D ', ':D', 2)).toBeNull();
    expect(typedAfterFace('', ':D ', 3)).toBeNull();
    expect(typedAfterFace('hello', 'hello ', 6)).toBeNull();
    expect(typedAfterFace(':D', ' :D', 1)).toBeNull();
  });

  test('text that changed elsewhere is not one keystroke', () => {
    expect(typedAfterFace('a :D', 'b :D ', 5)).toBeNull();
  });
});

describe('sending', () => {
  test('a face that ends the message becomes its emoji', () => {
    expect(withClosingEmoji('tamam :D')).toBe('tamam 😄');
    expect(withClosingEmoji(';)')).toBe('😉');
  });

  test('anything else is sent as written', () => {
    expect(withClosingEmoji('tamam')).toBe('tamam');
    expect(withClosingEmoji('a:D')).toBe('a:D');
    expect(withClosingEmoji('`x :D')).toBe('`x :D');
    expect(withClosingEmoji('')).toBe('');
  });
});
