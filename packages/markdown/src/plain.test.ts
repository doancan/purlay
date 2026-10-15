/**
 * A message as one line a list can show (#651): what a reader sees, never the marks that made it.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from './parse';
import { excerptOf, plainText } from './plain';

const plain = (text: string): string => {
  const tree = parseMarkdown(text);
  if (tree === null) throw new Error('past the bounds');
  return plainText(tree);
};

describe('plainText', () => {
  test('code spans are their contents, emphasis loses its marks', () => {
    expect(plain('Deployed `api` `06f1700` to **staging** in _84s_.')).toBe(
      'Deployed api 06f1700 to staging in 84s.',
    );
  });

  test('a link is its label, never its address', () => {
    expect(plain('see [the runbook](https://example.com/runbook) first')).toBe(
      'see the runbook first',
    );
  });

  test('blocks are one line: paragraphs, a list, a quote and a fence, in reading order', () => {
    expect(
      plain('First.\n\n- one\n- two\n\n> quoted\n\n```ts\nconst a = 1;\nconst b = 2;\n```'),
    ).toBe('First. one two quoted const a = 1; const b = 2;');
  });

  test('a mention stays as written', () => {
    expect(plain('@dogancan can you look?')).toBe('@dogancan can you look?');
  });

  test('a table is its cells; a rule and a line break are a space', () => {
    expect(plain('| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nline one  \nline two')).toBe(
      'a b 1 2 line one line two',
    );
  });
});

describe('excerptOf', () => {
  test('is the plain text of what parses', () => {
    expect(excerptOf('`code` and **bold**')).toBe('code and bold');
  });

  test('past the bounds, it is the message as typed — as the feed shows it — on one line', () => {
    const deep = `${'>'.repeat(200)} deep`;
    expect(parseMarkdown(deep)).toBeNull();
    expect(excerptOf(deep)).toBe(deep);
    expect(excerptOf('a\n\nb')).toBe('a b');
  });
});
