import { describe, expect, test } from 'bun:test';
import { literalPattern } from './like-pattern';

describe('what a person typed, as a pattern', () => {
  test('is the words between wildcards', () => {
    expect(literalPattern('ada')).toBe('%ada%');
  });

  test('keeps the characters LIKE would read as its own as plain characters', () => {
    expect(literalPattern('50%_off\\now')).toBe('%50\\%\\_off\\\\now%');
  });
});
