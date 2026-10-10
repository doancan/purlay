/**
 * Mentions, read the way D-99 §3 writes them down — and attacked, because the body
 * is sixteen thousand characters from anyone with a session.
 */
import { describe, expect, test } from 'bun:test';
import { MENTIONS_PER_MESSAGE_MAX, parseMentions } from './mentions';

const names = (content: string): readonly string[] => parseMentions(content).names;

describe('what is a mention', () => {
  test.each([
    ['@alice', ['alice']],
    ['hey @alice, look', ['alice']],
    ['@alice @bob', ['alice', 'bob']],
    ['(@alice)', ['alice']],
    ['@alice.', ['alice']],
    ['line one\n@alice', ['alice']],
    ['@a', ['a']],
    ['@A1-b2', ['A1-b2']],
    ['@Alice and @ALICE', ['Alice']],
    ['@alice-', ['alice']],
  ])('%j finds %j', (text, found) => {
    expect(names(text)).toEqual(found);
  });

  test.each([
    ['nothing here', 'no @ at all'],
    ['@', 'a bare @'],
    ['@ alice', 'a space after the @'],
    ['alice@example.com', 'an address: preceded by a word character'],
    ['@@alice', 'preceded by an @'],
    ['`x`@alice', 'glued to the end of a code span'],
    ['a`@alice`', 'inside a code span'],
    ['@-alice', 'a name cannot start with a hyphen'],
    ['@alice_bob', 'an underscore is not part of a name, and not a boundary either'],
    ['@aliçe', 'a letter outside ASCII is the start of a longer word'],
    ['＠alice', 'a full-width @ is not an @'],
    ['éalice@bob', 'preceded by a letter'],
  ])('%j finds nothing (%s)', (text) => {
    expect(names(text)).toEqual([]);
  });

  test('a hyphen is only inside a name, never doubled', () => {
    expect(names('@a--b')).toEqual(['a']);
    expect(names('@a-b-c')).toEqual(['a-b-c']);
  });

  test('a name longer than GitHub allows is not a mention of its first 39 characters', () => {
    const long = 'a'.repeat(40);
    expect(names(`@${long}`)).toEqual([]);
    expect(names(`@${long.slice(1)}`)).toEqual([long.slice(1)]);
  });

  test('the same person twice, in any case, is one name — the first spelling', () => {
    expect(names('@Alice @alice @ALICE')).toEqual(['Alice']);
  });

  test('no more than the bound are kept', () => {
    const text = Array.from(
      { length: MENTIONS_PER_MESSAGE_MAX + 20 },
      (_, n) => `@u${String(n)}`,
    ).join(' ');
    expect(names(text)).toHaveLength(MENTIONS_PER_MESSAGE_MAX);
    expect(names(text)[0]).toBe('u0');
  });
});

describe('code is quoting, not addressing', () => {
  test.each([
    ['`@alice`', []],
    ['``@alice``', []],
    ['```\n@alice\n```', []],
    ['```ts\nconst a = "@alice";\n```\n@bob', ['bob']],
    ['```\n@alice', []],
    ['@bob `@alice` @carol', ['bob', 'carol']],
    ['`` ` `` @alice', ['alice']],
    ['`a` and `b` @alice', ['alice']],
  ])('%j finds %j', (text, found) => {
    expect(names(text)).toEqual(found);
  });

  test('a backtick that is never closed is text, not the start of code', () => {
    expect(names('a ` @alice')).toEqual(['alice']);
    expect(names('`` @alice `')).toEqual(['alice']);
  });

  test('a run of a different length does not close a span', () => {
    expect(names('`a`` @alice')).toEqual(['alice']);
    expect(names('``a` @alice``')).toEqual([]);
  });

  test('an unclosed fence runs to the end of the text', () => {
    expect(names('before @bob\n```\n@alice\nmore @carol')).toEqual(['bob']);
  });
});

describe('the broadcasts the product does not have', () => {
  test.each(['@here', '@channel', '@everyone', '@HERE', '@Channel', 'ping @everyone now'])(
    '%j is refused',
    (text) => {
      expect(parseMentions(text).broadcast).not.toEqual([]);
    },
  );

  test('they are reported, lower case and once, and are not names', () => {
    const parsed = parseMentions('@Here @here @channel @alice');
    expect(parsed.broadcast).toEqual(['here', 'channel']);
    expect(parsed.names).toEqual(['alice']);
  });

  test('a name that merely starts like one is a name', () => {
    expect(parseMentions('@heretic @channels').broadcast).toEqual([]);
    expect(names('@heretic @channels')).toEqual(['heretic', 'channels']);
  });

  test('in code they are somebody quoting', () => {
    expect(parseMentions('`@here` and ```\n@channel\n```').broadcast).toEqual([]);
  });
});

describe('the body is attacker-sized', () => {
  const time = (text: string): number => {
    const started = performance.now();
    parseMentions(text);
    return performance.now() - started;
  };

  test.each([
    ['ten thousand @', '@'.repeat(10_000)],
    ['ten thousand backticks', '`'.repeat(10_000)],
    [
      'alternating backtick runs of every length',
      Array.from({ length: 2_000 }, (_, n) => '`'.repeat((n % 7) + 1) + 'a').join(' '),
    ],
    ['a name that almost matches, repeated', '@' + 'a-'.repeat(5_000)],
    ['hyphen after hyphen', '@a' + '-'.repeat(10_000)],
    ['sixteen thousand characters of mentions', '@alice '.repeat(2_200)],
    ['unclosed fences', '```\n'.repeat(3_000)],
  ])('%s is linear, not quadratic', (_label, text) => {
    expect(text.length).toBeLessThanOrEqual(16_000);
    // Generous: it passes in a few milliseconds, and a quadratic or exponential
    // scan of 10,000 characters takes seconds.
    expect(time(text)).toBeLessThan(250);
  });

  test('scaling the input tenfold does not scale the work a hundredfold', () => {
    const small = '`a` @b '.repeat(200);
    const large = '`a` @b '.repeat(2_000);
    // Warm both, then compare the best of a few runs to keep the noise out.
    const best = (text: string): number => Math.min(time(text), time(text), time(text));
    best(small);
    expect(best(large)).toBeLessThan(Math.max(5, best(small) * 60));
  });
});
