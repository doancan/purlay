/**
 * What a body is read as (D-101) — and, as much, what it is not.
 *
 * The second half is the sanitiser (#43): every construct below that the product does not
 * render must come out as the characters that were typed, because the tree is the only thing a
 * renderer is given and nothing outside it can reach the page.
 */
import { describe, expect, test } from 'bun:test';
import type { PhrasingContent, Root } from 'mdast';
import {
  narrowTree,
  parseMarkdown,
  readMarkdown,
  withoutFencedCode,
  MARKDOWN_DEPTH_MAX,
  type Engine,
} from './parse';
import { SafeHref } from './href';
import { MARKDOWN_DELIMITERS_MAX } from './scan';
import type { Block, Inline, MessageTree } from './tree';

const tree = (text: string): MessageTree => {
  const parsed = parseMarkdown(text);
  if (parsed === null) throw new Error(`expected a tree for ${JSON.stringify(text)}`);
  return parsed;
};
const blocks = (text: string): readonly Block[] => tree(text).children;
const inline = (text: string): readonly Inline[] => {
  const [first] = blocks(text);
  if (first?.type !== 'paragraph')
    throw new Error(`expected one paragraph for ${JSON.stringify(text)}`);
  return first.children;
};
const text = (value: string): Inline => ({ type: 'text', value });
/** Every text value in the tree, joined: what a reader sees of the body. */
const shown = (value: MessageTree): string => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if ('value' in node && typeof node.value === 'string') out.push(node.value);
    if ('children' in node && Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(value);
  return out.join('');
};
/** Every url a link in the tree carries. */
const urls = (value: MessageTree): string[] => {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if ('url' in node) {
      // A url of any other kind would be skipped here, and every "no link" test would pass on it.
      if (!(node.url instanceof SafeHref)) throw new Error('a link carries an unchecked address');
      out.push(node.url.href);
    }
    if ('children' in node && Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(value);
  return out;
};

describe('what is rendered', () => {
  test('emphasis, strong, strikethrough and inline code', () => {
    expect(inline('*a* **b** ~~c~~ `d`')).toEqual([
      { type: 'emphasis', children: [text('a')] },
      text(' '),
      { type: 'strong', children: [text('b')] },
      text(' '),
      { type: 'delete', children: [text('c')] },
      text(' '),
      { type: 'inlineCode', value: 'd' },
    ]);
  });

  test('a fence, with the first word of its info string as the language', () => {
    expect(blocks('```ts title\nconst x = 1\n```')).toEqual([
      { type: 'code', lang: 'ts', value: 'const x = 1' },
    ]);
    expect(blocks('```\nplain\n```')).toEqual([{ type: 'code', lang: null, value: 'plain' }]);
  });

  test('lists, ordered from their first number, and task items with their box', () => {
    expect(blocks('3. a\n4. b')).toEqual([
      {
        type: 'list',
        ordered: true,
        start: 3,
        children: [
          {
            type: 'listItem',
            checked: null,
            children: [{ type: 'paragraph', children: [text('a')] }],
          },
          {
            type: 'listItem',
            checked: null,
            children: [{ type: 'paragraph', children: [text('b')] }],
          },
        ],
      },
    ]);
    const [list] = blocks('- [ ] open\n- [x] done');
    expect(list?.type === 'list' ? list.children.map((item) => item.checked) : null).toEqual([
      false,
      true,
    ]);
  });

  test('a quotation, a rule and a table with its alignment', () => {
    expect(blocks('> said')).toEqual([
      { type: 'blockquote', children: [{ type: 'paragraph', children: [text('said')] }] },
    ]);
    expect(blocks('a\n\n***\n\nb')[1]).toEqual({ type: 'thematicBreak' });
    expect(blocks('| a | b |\n|:--|--:|\n| 1 | 2 |')).toEqual([
      {
        type: 'table',
        align: ['left', 'right'],
        children: [
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('a')] },
              { type: 'tableCell', children: [text('b')] },
            ],
          },
          {
            type: 'tableRow',
            children: [
              { type: 'tableCell', children: [text('1')] },
              { type: 'tableCell', children: [text('2')] },
            ],
          },
        ],
      },
    ]);
  });

  test('an ATX heading is a heading, and says its level, at most 3: the sizes there are are three', () => {
    expect(blocks('### Release')).toEqual([
      { type: 'heading', level: 3, children: [text('Release')] },
    ]);
    expect(blocks('# Release')).toEqual([
      { type: 'heading', level: 1, children: [text('Release')] },
    ]);
    expect(blocks('## Release')).toEqual([
      { type: 'heading', level: 2, children: [text('Release')] },
    ]);
    expect(blocks('###### Release')).toEqual([
      { type: 'heading', level: 3, children: [text('Release')] },
    ]);
  });

  test('links to http, https and mailto, written or bare', () => {
    expect(
      urls(tree('[a](https://a.example/x) [b](http://b.example) [c](mailto:c@d.example)')),
      // As the browser reads them: the checked string is the rendered one, so `http://b.example` gains its `/`.
    ).toEqual(['https://a.example/x', 'http://b.example/', 'mailto:c@d.example']);
    expect(urls(tree('see www.github.com/o/r and e@f.example'))).toEqual([
      'http://www.github.com/o/r',
      'mailto:e@f.example',
    ]);
  });

  test('a hard line break, and a soft one kept as the newline that was typed', () => {
    expect(inline('a  \nb')).toEqual([text('a'), { type: 'break' }, text('b')]);
    expect(inline('a\nb')).toEqual([text('a\nb')]);
  });
});

describe('what is not, and stays the characters that were typed', () => {
  test.each([
    ['raw HTML, inline', 'x <img src=x onerror=alert(1)> y'],
    ['raw HTML, a block', '<script>alert(1)</script>'],
    ['a character reference', '&lt;b&gt; &#106;avascript'],
    ['an indented line, which is not code here', '    indented'],
    ['a footnote', 'a[^1]\n\n[^1]: note'],
  ])('%s', (_, body) => {
    const value = tree(body);
    expect(urls(value)).toEqual([]);
    expect(value.children.every((block) => block.type === 'paragraph')).toBe(true);
    expect(shown(value).trim()).toBe(body.replace(/\n\n/g, '').trim());
  });

  test('a setext underline does not make a heading: only `#` does', () => {
    expect(blocks('Title\n===')).toEqual([{ type: 'paragraph', children: [text('Title\n===')] }]);
  });

  test('an image is a link to the image, labelled with its alt text, until there is a proxy (#110)', () => {
    const [bang, link] = inline('![diagram](https://e.example/d.png)');
    expect(bang).toEqual(text('!'));
    expect(link?.type === 'link' ? link.children : null).toEqual([text('diagram')]);
    expect(urls(tree('![diagram](https://e.example/d.png)'))).toEqual(['https://e.example/d.png']);
  });

  test('a reference definition does not exist, so neither does a link that uses it', () => {
    const value = tree('[x][1]\n\n[1]: javascript:alert(1)');
    expect(urls(value)).toEqual([]);
    expect(shown(value)).toContain('javascript:alert(1)');
  });

  test.each([
    ['javascript:', '[a](javascript:alert(1))'],
    ['JavaScript: in another case', '[a](JaVaScRiPt:alert(1))'],
    ['data:', '[a](data:text/html,<b>x</b>)'],
    ['vbscript:', '[a](vbscript:x)'],
    ['a relative address', '[a](rel/path)'],
    ['a protocol-relative address', '[a](//evil.example)'],
    ['a fragment', '[a](#top)'],
    ['file:', '[a](file:///etc/passwd)'],
  ])('a link to %s is its label, not a link', (_, body) => {
    expect(inline(body)).toEqual([text('a')]);
  });
});

describe('a body too complex to format is shown as typed', () => {
  test('one delimiter past the limit, outside code, is no tree', () => {
    const at = '*a'.repeat(MARKDOWN_DELIMITERS_MAX);
    expect(parseMarkdown(at)).not.toBeNull();
    expect(parseMarkdown(`${at}*`)).toBeNull();
  });

  test('nesting the scan cannot see is caught on the tree', () => {
    const nested = (depth: number): string => `${'*'.repeat(depth)}a${'*'.repeat(depth)}`;
    // Emphasis nests one level per pair of delimiters, inside the delimiter budget.
    expect(parseMarkdown(nested(3 * MARKDOWN_DEPTH_MAX))).toBeNull();
    expect(parseMarkdown(nested(10))).not.toBeNull();
  });

  test('the engine failing inside the bounds is returned with its cause, never thrown', () => {
    const cause = new RangeError('Maximum call stack size exceeded');
    const failing = (): never => {
      throw cause;
    };
    const working: Engine = { blocks: () => ({ type: 'root', children: [] }), full: failing };
    expect(readMarkdown('a', working)).toEqual({ tree: null, reason: 'engine', error: cause });
    expect(readMarkdown('a', { ...working, blocks: failing })).toEqual({
      tree: null,
      reason: 'engine',
      error: cause,
    });
  });
});

/** A source position, as the engine writes them. */
type Position = NonNullable<Root['position']>;

describe('the narrowing alone, on what the engine is configured never to produce', () => {
  // Built by hand: the engine cannot make these (`engine.test.ts`), so the second layer is proven here.
  const at = (start: number, end: number): Position => ({
    start: { line: 1, column: start + 1, offset: start },
    end: { line: 1, column: end + 1, offset: end },
  });

  test('every inline kind it has no place for is the characters it was written with', () => {
    const source = '<b>![i](u)[r][1][^1]';
    const root: Root = {
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'html', value: '<b>', position: at(0, 3) },
            { type: 'image', url: 'u', alt: 'i', position: at(3, 10) },
            {
              type: 'linkReference',
              identifier: '1',
              label: '1',
              referenceType: 'full',
              children: [],
              position: at(10, 16),
            },
            { type: 'footnoteReference', identifier: '1', position: at(16, 20) },
          ],
        },
      ],
    };
    expect(narrowTree(root, source).children).toEqual([
      { type: 'paragraph', children: [text(source)] },
    ]);
  });

  test('every block kind it has no place for is a paragraph of its characters', () => {
    const source = '<div>[1]: javascript:x';
    const root: Root = {
      type: 'root',
      children: [
        { type: 'html', value: '<div>', position: at(0, 5) },
        {
          type: 'definition',
          identifier: '1',
          label: '1',
          url: 'javascript:x',
          position: at(5, 22),
        },
      ],
    };
    expect(narrowTree(root, source).children).toEqual([
      { type: 'paragraph', children: [text('<div>')] },
      { type: 'paragraph', children: [text('[1]: javascript:x')] },
    ]);
  });

  test('a node with no position in the source is a defect that throws, not text that vanishes', () => {
    const root: Root = {
      type: 'root',
      children: [
        { type: 'paragraph', children: [{ type: 'image', url: 'javascript:x', alt: 'a' }] },
      ],
    };
    expect(() => narrowTree(root, '')).toThrow('has no position');
  });
});

describe('the depth of the narrowed tree', () => {
  /** A paragraph holding `levels` emphases, one inside the next. */
  const nested = (levels: number): Root => {
    let inner: PhrasingContent = { type: 'text', value: 'a' };
    for (let level = 0; level < levels; level += 1) inner = { type: 'emphasis', children: [inner] };
    return { type: 'root', children: [{ type: 'paragraph', children: [inner] }] };
  };
  // The root's blocks are depth 1 and a paragraph's inlines depth 2; each emphasis is one more.
  const deepestAllowed = MARKDOWN_DEPTH_MAX - 2;

  test('at the limit and one below it is narrowed, one above it is not', () => {
    expect(() => narrowTree(nested(deepestAllowed - 1), 'a')).not.toThrow();
    expect(() => narrowTree(nested(deepestAllowed), 'a')).not.toThrow();
    expect(() => narrowTree(nested(deepestAllowed + 1), 'a')).toThrow();
  });

  test('lists nested across lines, which no line scan sees, are bounded there too', () => {
    const outline = Array.from(
      { length: MARKDOWN_DEPTH_MAX },
      (_, level) => `${'  '.repeat(level)}- a`,
    ).join('\n');
    expect(readMarkdown(outline)).toEqual({ tree: null, reason: 'depth' });
  });
});

describe('a link in other spellings', () => {
  test.each([
    ['an angle-bracket autolink', '<javascript:alert(1)>'],
    ['an escaped colon', '[a](javascript\\:alert(1))'],
    ['a scheme split by an entity', '[a](java&#115;cript:alert(1))'],
  ])('to javascript: as %s is no link', (_, body) => {
    expect(urls(tree(body))).toEqual([]);
  });
});

test('a link that became its label leaves the sentence in one piece', () => {
  expect(inline('x [a](rel/path) y')).toEqual([text('x a y')]);
});

describe('the body with fenced code blanked, for the mention parser', () => {
  test.each([
    ['a tilde fence', '~~~\n@bob\n~~~'],
    ['a fence inside a list item', '- item\n\n  ```\n  @bob\n  ```'],
    ['a fence inside a quotation', '> ```\n> @bob\n> ```'],
    ['an indented fence', '      ```\n@bob\n      ```'],
  ])('blanks %s, keeping every line where it was', (_, body) => {
    const blanked = withoutFencedCode(body);
    expect(blanked).not.toContain('@bob');
    expect(blanked.length).toBe(body.length);
    expect(blanked.split('\n').length).toBe(body.split('\n').length);
  });

  test('leaves prose, and inline code, to the mention parser', () => {
    expect(withoutFencedCode('hi @bob, `@carol`')).toBe('hi @bob, `@carol`');
  });

  test('returns the body unchanged when the bounds forbid its block reading, or the engine fails', () => {
    const deep = `${'> '.repeat(64)}~~~\n@bob\n~~~`;
    expect(withoutFencedCode(deep)).toBe(deep);
    const failing: Engine = {
      blocks: () => {
        throw new Error('engine');
      },
      full: () => ({ type: 'root', children: [] }),
    };
    expect(withoutFencedCode('~~~\n@bob\n~~~', failing)).toBe('~~~\n@bob\n~~~');
  });
});
