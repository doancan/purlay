/**
 * The shape of a mention, shared by the server's resolution and the client's highlight. The
 * server's own tests (`apps/api/src/modules/messages/mentions.test.ts`) still pin what it does with
 * the shape — code, refusal, the cap — unchanged by the move.
 */
import { describe, expect, test } from 'bun:test';
import { mentionsIn } from './mentions';

const names = (text: string): string[] => mentionsIn(text).map((span) => span.name);

describe('mentionsIn', () => {
  test('finds each name with where it is, as written', () => {
    expect(mentionsIn('hi @Bob and @a-b.')).toEqual([
      { start: 3, end: 7, name: 'Bob' },
      { start: 12, end: 16, name: 'a-b' },
    ]);
  });

  test('a name is 39 characters at most; a fortieth makes it a longer word, not a shorter name', () => {
    expect(names(`@${'a'.repeat(39)}`)).toEqual(['a'.repeat(39)]);
    expect(names(`@${'a'.repeat(40)}`)).toEqual([]);
  });

  test.each([
    ['an address', 'mail a@bob.example'],
    ['a doubled sign', '@@bob'],
    ['the end of a code span', '`x`@bob'],
    ['a letter outside ASCII', 'é@bob'],
    ['a digit', '1@bob'],
    ['an underscore', '_@bob'],
  ])('is not one after %s', (_, text) => {
    expect(names(text)).toEqual([]);
  });

  test.each([
    ['a hyphen at the end, which is not part of it', '@bob-', ['bob']],
    ['a double hyphen, which ends it', '@bob--x', ['bob']],
    ['a leading hyphen, which is not a name', '@-bob', []],
    ['a letter outside ASCII after it, which makes it a longer word', '@bobé', []],
    ['punctuation and emphasis around it', '(**@bob**), @carol!', ['bob', 'carol']],
  ])('%s', (_, text, expected) => {
    expect(names(text)).toEqual(expected);
  });

  test('calls share no state: the same text read twice reads the same', () => {
    expect(names('@a @b')).toEqual(['a', 'b']);
    expect(names('@a @b')).toEqual(['a', 'b']);
  });
});
