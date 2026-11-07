import { describe, expect, test } from 'bun:test';
import { oneLine } from './one-line';

describe('oneLine', () => {
  test('is the first line with something on it, trimmed', () => {
    expect(oneLine('\n  \n  the deploy  \nis at noon', 50)).toBe('the deploy');
    expect(oneLine('', 50)).toBe('');
  });

  test('is cut at the limit, with the ellipsis inside it', () => {
    expect(oneLine('a'.repeat(10), 10)).toBe('a'.repeat(10));
    expect(oneLine('a'.repeat(11), 10)).toBe(`${'a'.repeat(9)}…`);
  });

  test('never ends in half of an emoji', () => {
    const cut = oneLine(`${'a'.repeat(8)}😀😀`, 10);
    expect(cut).toBe(`${'a'.repeat(8)}…`);
    expect(cut.length).toBeLessThanOrEqual(10);
  });
});
