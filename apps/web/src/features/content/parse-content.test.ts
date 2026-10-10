/**
 * What a message's text is read as, and — as much — what it is not. The recognised things
 * are three; everything else stays the characters that were typed.
 */
import { describe, expect, test } from 'bun:test';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import { parseContent, type Block, type Inline } from './parse-content';

const inline = (text: string): readonly Inline[] => {
  const [block] = parseContent(text);
  if (block?.kind !== 'text') throw new Error(`expected a text block for ${JSON.stringify(text)}`);
  return block.inline;
};
const text = (value: string): Inline => ({ kind: 'text', value });

describe('plain text', () => {
  test('is kept exactly, line breaks and all', () => {
    expect(parseContent('one\ntwo  spaced\n\nthree')).toEqual([
      { kind: 'text', inline: [text('one\ntwo  spaced\n\nthree')] },
    ]);
  });

  test('markdown is not interpreted: that is Phase 1 and O-6', () => {
    expect(inline('**bold** _it_ # head <b>x</b> [a](b)')).toEqual([
      text('**bold** _it_ # head <b>x</b> [a](b)'),
    ]);
  });

  test('an empty message is one empty text block, so nothing renders as nothing', () => {
    expect(parseContent('')).toEqual([{ kind: 'text', inline: [] }]);
  });
});

describe('inline code', () => {
  test('is the text between two backticks on one line', () => {
    expect(inline('run `bun test` now')).toEqual([
      text('run '),
      { kind: 'code', value: 'bun test' },
      text(' now'),
    ]);
  });

  test('a backtick with no partner, an empty pair, and a pair split by a line break are text', () => {
    expect(inline('a ` b')).toEqual([text('a ` b')]);
    expect(inline('a `` b')).toEqual([text('a `` b')]);
    expect(inline('a `b\nc` d')).toEqual([text('a `b\nc` d')]);
  });

  test('keeps links and mentions inside it as the characters they are', () => {
    expect(inline('`https://x.test @bob`')).toEqual([
      { kind: 'code', value: 'https://x.test @bob' },
    ]);
  });
});

describe('links', () => {
  test('a bare http or https address is a link, without the punctuation that ends the sentence', () => {
    expect(inline('see https://example.test/a?b=1#c, ok.')).toEqual([
      text('see '),
      { kind: 'link', href: 'https://example.test/a?b=1#c', label: 'https://example.test/a?b=1#c' },
      text(', ok.'),
    ]);
    expect(inline('(http://example.test/x)')).toEqual([
      text('('),
      { kind: 'link', href: 'http://example.test/x', label: 'http://example.test/x' },
      text(')'),
    ]);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://example.test/file',
    'file:///etc/passwd',
    'https://',
    'xhttps://example.test',
  ])('%s is text, not a link', (candidate) => {
    expect(inline(candidate).every((piece) => piece.kind !== 'link')).toBe(true);
  });

  test('is not found in the middle of a word, and is case-insensitive in its scheme', () => {
    expect(inline('nothttps://example.test')).toEqual([text('nothttps://example.test')]);
    expect(inline('HTTPS://Example.test/A')[0]).toMatchObject({
      kind: 'link',
      href: 'https://example.test/A',
    });
  });

  test('stops at an angle bracket or a line break', () => {
    expect(inline('<https://example.test/a>')).toEqual([
      text('<'),
      { kind: 'link', href: 'https://example.test/a', label: 'https://example.test/a' },
      text('>'),
    ]);
    expect(inline('https://example.test/a\nnext')).toEqual([
      { kind: 'link', href: 'https://example.test/a', label: 'https://example.test/a' },
      text('\nnext'),
    ]);
  });
});

describe('mentions', () => {
  test('the shape is @name where a name is a username, and the text around it stays', () => {
    expect(inline('hi @alice, and @bob-2.')).toEqual([
      text('hi '),
      { kind: 'mention', name: 'alice', raw: '@alice' },
      text(', and '),
      { kind: 'mention', name: 'bob-2', raw: '@bob-2' },
      text('.'),
    ]);
  });

  test.each(['mail@host.test', '@@alice', 'a_@alice', '`@alice`', '@-x', '@', '@ x'])(
    '%j names nobody',
    (candidate) => {
      expect(inline(candidate).every((piece) => piece.kind !== 'mention')).toBe(true);
    },
  );

  test('a name is at most 39 characters and does not end on a hyphen', () => {
    const long = 'a'.repeat(50);
    expect(inline(`@${long}`)[0]).toMatchObject({ kind: 'mention', name: 'a'.repeat(39) });
    expect(inline('@abc- x')).toEqual([{ kind: 'mention', name: 'abc', raw: '@abc' }, text('- x')]);
  });

  test("@here and @channel are just names to the parser; refusing them is the server's and the composer's", () => {
    expect(inline('@here')).toEqual([{ kind: 'mention', name: 'here', raw: '@here' }]);
  });
});

describe('fenced code', () => {
  const fence = (language: string, code: string): Block => ({ kind: 'fence', language, code });

  test('is a block with its language and its lines, between the text around it', () => {
    expect(parseContent('before\n```ts\nconst a = 1;\nconst b = 2;\n```\nafter')).toEqual([
      { kind: 'text', inline: [text('before')] },
      fence('ts', 'const a = 1;\nconst b = 2;'),
      { kind: 'text', inline: [text('after')] },
    ]);
  });

  test('a fence with no language, an empty one, and two in a row', () => {
    expect(parseContent('```\nx\n```')).toEqual([fence('', 'x')]);
    expect(parseContent('```\n```')).toEqual([fence('', '')]);
    expect(parseContent('```a\n1\n```\n```b\n2\n```')).toEqual([fence('a', '1'), fence('b', '2')]);
  });

  test('takes the first word of the info string, lower-cased, and allows a little indent', () => {
    expect(parseContent('  ```TypeScript title="x"\ny\n  ```')).toEqual([fence('typescript', 'y')]);
  });

  test('is kept literal inside: no links, no mentions, no inner fences', () => {
    const [block] = parseContent('```\nhttps://x.test @bob `y`\n```');
    expect(block).toEqual(fence('', 'https://x.test @bob `y`'));
  });

  test('with no closing line is the text it was typed as, and the rest of it is still read', () => {
    expect(parseContent('```ts\nconst a = `b`;')).toEqual([
      {
        kind: 'text',
        inline: [text('```ts\nconst a = '), { kind: 'code', value: 'b' }, text(';')],
      },
    ]);
  });

  test('three backticks in the middle of a line are inline code or text, never a fence', () => {
    expect(parseContent('x ```not a fence``` y')[0]?.kind).toBe('text');
    expect(parseContent('```not `a` fence')[0]?.kind).toBe('text');
  });
});

describe('adversarial input, at the longest a message may be', () => {
  const time = (input: string): number => {
    const start = performance.now();
    parseContent(input);
    return performance.now() - start;
  };
  const cases: [string, string][] = [
    ['backticks alone', '`'.repeat(MESSAGE_CONTENT_MAX)],
    ['alternating backticks and text', '` x'.repeat(MESSAGE_CONTENT_MAX / 3)],
    ['an opening backtick on every line', '`\nx\n'.repeat(MESSAGE_CONTENT_MAX / 4)],
    ['openers of fences with no closer', '```a\n'.repeat(MESSAGE_CONTENT_MAX / 5)],
    ['http without end', 'http://'.repeat(MESSAGE_CONTENT_MAX / 7)],
    ['one very long link', `https://${'a'.repeat(MESSAGE_CONTENT_MAX - 8)}`],
    ['mentions without end', '@a'.repeat(MESSAGE_CONTENT_MAX / 2)],
    ['one long name', `@${'a-'.repeat(MESSAGE_CONTENT_MAX / 2 - 1)}`],
    ['punctuation after a link', `https://x.test${'.'.repeat(MESSAGE_CONTENT_MAX - 14)}`],
  ];

  test.each(cases)('%s is read in well under a frame budget', (_name, input) => {
    expect(input.length).toBeLessThanOrEqual(MESSAGE_CONTENT_MAX);
    // Linear work on 16,000 characters is a few milliseconds; a quadratic one is seconds.
    expect(time(input)).toBeLessThan(250);
  });

  test('doubling the input does not quadruple the time', () => {
    const small = '` x'.repeat(4000);
    const large = '` x'.repeat(16000);
    time(small);
    const a = Math.max(time(small), 0.05);
    const b = time(large);
    expect(b / a).toBeLessThan(16);
  });
});
