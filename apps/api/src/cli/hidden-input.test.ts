/** The keys of a line typed with nothing shown: what ends up in a password, and what never does. */
import { describe, expect, test } from 'bun:test';
import { NEW_LINE, typed } from './hidden-input';

const run = (...chunks: string[]): ReturnType<typeof typed> => chunks.reduce(typed, NEW_LINE);

describe('a line typed with nothing shown', () => {
  test('is what was typed, submitted by Enter, with Backspace taking the last character', () => {
    expect(run('abc\u007fd\r')).toEqual({ value: 'abd', escape: null, done: 'submit' });
    expect(run('é\u007f\r').value).toBe('');
  });

  test('ignores an arrow, Home and Delete whole — they never reach the password', () => {
    expect(run('ab\u001b[Dc\u001b[A\u001b[1~\u001b[3~d\r').value).toBe('abcd');
    expect(run('a\u001bOHb\r').value).toBe('ab');
  });

  test('ignores a sequence split over two reads', () => {
    expect(run('a\u001b', '[', '1;5', 'Cb\r').value).toBe('ab');
  });

  test('Ctrl-C cancels; Ctrl-D on an empty line cancels, on a line with something in it submits', () => {
    expect(run('abc\u0003').done).toBe('cancel');
    expect(run('\u0004').done).toBe('cancel');
    expect(run('abc\u0004')).toEqual({ value: 'abc', escape: null, done: 'submit' });
  });

  test('keeps no control character', () => {
    expect(run('a\tb\u0001c\r').value).toBe('abc');
  });
});
