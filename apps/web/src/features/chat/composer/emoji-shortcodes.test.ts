import { describe, expect, test } from 'bun:test';
import { shortcodeQuery } from './emoji-shortcodes';

const at = (text: string): ReturnType<typeof shortcodeQuery> => shortcodeQuery(text, text.length);

describe('shortcodeQuery', () => {
  test('two letters after a colon at the end of the text are a query', () => {
    expect(at(':ta')).toEqual({ start: 0, query: 'ta' });
    expect(at('well done :tada')).toEqual({ start: 10, query: 'tada' });
  });

  test('one letter is still punctuation, so a face typed as text is left alone', () => {
    expect(at(':')).toBeNull();
    expect(at(':t')).toBeNull();
    expect(at(':D')).toBeNull();
    expect(at(':P')).toBeNull();
  });

  test('a colon glued to a word, a digit or an address is not a shortcode', () => {
    expect(at('12:30')).toBeNull();
    expect(at('Note:tada')).toBeNull();
    expect(at('http://example.com:80')).toBeNull();
    expect(at('a::tada')).toBeNull();
  });

  test('a space or a line break ends the query', () => {
    expect(at(':tada and')).toBeNull();
    expect(at(':tada\nmore')).toBeNull();
  });

  test('the query follows the caret, and a caret inside a word is moving through it', () => {
    expect(shortcodeQuery('x :ta more', 5)).toEqual({ start: 2, query: 'ta' });
    expect(shortcodeQuery('x :tada', 5)).toBeNull();
    expect(shortcodeQuery(':tada', 3)).toBeNull();
  });

  test('inside a fence or inline code a colon is code', () => {
    expect(at('```\n:tada')).toBeNull();
    expect(at('`:tada')).toBeNull();
  });

  test('a name too long to be one is not a query', () => {
    expect(at(`:${'a'.repeat(80)}`)).toBeNull();
  });

  test('plus and minus belong to names such as +1 and -1 only after a letter', () => {
    expect(at(':thumbsup')).not.toBeNull();
    expect(at(':+1')).toEqual({ start: 0, query: '+1' });
  });
});
