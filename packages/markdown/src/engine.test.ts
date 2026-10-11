/**
 * The engine's half of the sanitiser: what it is configured never to recognise, it never does.
 *
 * `parse.ts` turns any such node into the characters that were typed as well, so the two layers
 * are each enough on their own. That is why each is tested on its own: through the narrowed tree a
 * construct the engine had stopped refusing would look exactly the same, until the day the
 * narrowing changed (`scripts/mutations.ts`).
 */
import { describe, expect, test } from 'bun:test';
import type { Nodes } from 'mdast';
import { blockTreeOf, syntaxTreeOf } from './engine';

const kindsOf = (tree: Nodes): Set<string> => {
  const kinds = new Set<string>();
  const walk = (node: Nodes): void => {
    kinds.add(node.type);
    if ('children' in node) node.children.forEach(walk);
  };
  walk(tree);
  return kinds;
};

const NEVER = [
  'html',
  'definition',
  'image',
  'imageReference',
  'linkReference',
  'footnoteDefinition',
  'footnoteReference',
];

describe.each([
  ['the full reading', syntaxTreeOf],
  ['the block reading', blockTreeOf],
])('%s never recognises', (_, read) => {
  test.each([
    ['raw HTML inline', 'x <img src=x onerror=alert(1)> y'],
    ['raw HTML as a block', '<script>\nalert(1)\n</script>'],
    [
      'a reference definition and its use',
      '[x][1] [y][]\n\n[1]: javascript:alert(1)\n[y]: https://e.example',
    ],
    ['an image', '![alt](https://e.example/i.png)'],
    ['a footnote', 'a[^1]\n\n[^1]: note'],
    ['an indented block as code', '    not code'],
  ])('%s', (_, body) => {
    const kinds = kindsOf(read(body));
    for (const kind of NEVER) expect(kinds.has(kind)).toBe(false);
    if (body.startsWith('    ')) expect(kinds.has('code')).toBe(false);
  });
});

test('a setext underline is not a heading, and a character reference is its characters', () => {
  expect(kindsOf(syntaxTreeOf('Title\n===')).has('heading')).toBe(false);
  const [paragraph] = syntaxTreeOf('&lt;b&gt;').children;
  expect(paragraph?.type === 'paragraph' ? paragraph.children : null).toEqual([
    expect.objectContaining({ type: 'text', value: '&lt;b&gt;' }),
  ]);
});
