import { describe, expect, test } from 'bun:test';
import { type FormattingRange, formattingRanges } from './formatting';

describe('formatting source ranges', () => {
  test.each([
    '# Heading',
    'one  \ntwo',
    '<div>plain HTML</div>',
    '[ref]: https://example.com\n\n[label][ref]',
    '![alt](https://example.com/a.png)',
    '[image]: https://example.com/a.png\n\n![alt][image]',
    '[^note]: a footnote\n\nreference[^note]',
  ])('unformatted syntax creates no toolbar marks: %s', (source) => {
    expect(formattingRanges(source)).toEqual([]);
  });
  test('positions use textarea UTF-16 offsets, including emoji before the format', () => {
    const source = '🚀 **İstanbul**';
    const ranges = formattingRanges(source);
    const bold = ranges?.find((range) => range.kind === 'bold');
    if (bold === undefined) throw new Error('no strong range');
    expect(source.slice(bold.start, bold.end)).toBe('**İstanbul**');
    expect(source.slice(bold.contentStart, bold.contentEnd)).toBe('İstanbul');
    expect(bold.start).toBe(3);
  });

  test('the rendering bounds also bound source metadata', () => {
    expect(formattingRanges('> '.repeat(500) + '**word**')).toBeNull();
  });

  test('code contents never create emphasis or list ranges', () => {
    expect(formattingRanges('```\n**bold**\n- item\n```')?.map((range) => range.kind)).toEqual([
      'code',
    ]);
  });
});

/** The source of every range of one kind, so that a test reads what the control would select. */
const marked = (
  source: string,
  kind: FormattingRange['kind'],
): { whole: string; content: string }[] =>
  (formattingRanges(source) ?? [])
    .filter((range) => range.kind === kind)
    .map((range) => ({
      whole: source.slice(range.start, range.end),
      content: source.slice(range.contentStart, range.contentEnd),
    }));

describe('what each writing control marks in the source', () => {
  test.each([
    ['italic with asterisks', '*one*', 'italic', '*one*', 'one'],
    ['italic with underscores', '_one_', 'italic', '_one_', 'one'],
    ['strike with two tildes', '~~gone~~', 'strike', '~~gone~~', 'gone'],
    ['strike with one tilde', '~gone~', 'strike', '~gone~', 'gone'],
    ['inline code', '`x`', 'inlineCode', '`x`', 'x'],
    ['inline code that holds a backtick, fenced by two', '``a`b``', 'inlineCode', '``a`b``', 'a`b'],
  ] as const)('%s: the delimiters are outside the content', (_, source, kind, whole, content) => {
    expect(marked(source, kind)).toEqual([{ whole, content }]);
  });

  test('a quote is marked from its marker to its end, with no delimiter to skip', () => {
    expect(marked('> quoted', 'quote')).toEqual([{ whole: '> quoted', content: '> quoted' }]);
  });

  test('a list is marked as a whole and item by item, each item one level deeper than the list', () => {
    const ranges = formattingRanges('- one\n- two') ?? [];
    expect(ranges.map((range) => [range.kind, range.depth])).toEqual([
      ['bullets', 1],
      ['bullets', 2],
      ['bullets', 2],
    ]);
    expect(marked('- one\n- two', 'bullets').map((range) => range.whole)).toEqual([
      '- one\n- two',
      '- one',
      '- two',
    ]);
  });

  test('a numbered list is numbers, and a list of tasks is tasks, in the list and in each item', () => {
    expect(marked('1. one\n2. two', 'numbers').map((range) => range.whole)).toEqual([
      '1. one\n2. two',
      '1. one',
      '2. two',
    ]);
    expect(marked('- [ ] a\n- [x] b', 'tasks').map((range) => range.whole)).toEqual([
      '- [ ] a\n- [x] b',
      '- [ ] a',
      '- [x] b',
    ]);
  });

  test('a list that mixes tasks and plain items is no kind as a whole: each item is what it is', () => {
    const source = '- [ ] a\n- b';
    expect(marked(source, 'tasks')).toEqual([{ whole: '- [ ] a', content: '- [ ] a' }]);
    expect(marked(source, 'bullets')).toEqual([{ whole: '- b', content: '- b' }]);
    expect(formattingRanges(source)?.every((range) => range.depth === 2)).toBe(true);
  });

  test.each(['- ', '-\t', '1. '])(
    'a bare list marker %j keeps its trailing space or tab, which the parser leaves out of its position',
    (source) => {
      const ranges = formattingRanges(source) ?? [];
      expect(ranges.length).toBeGreaterThan(0);
      for (const range of ranges) expect(source.slice(range.start, range.end)).toBe(source);
    },
  );

  test('a format nested in another is one level deeper, and a list inside a quote is inside it', () => {
    const [quote, list] = formattingRanges('> - item') ?? [];
    expect(quote).toMatchObject({ kind: 'quote', start: 0, end: 8, depth: 1 });
    expect(list).toMatchObject({ kind: 'bullets', start: 2, end: 8, depth: 2 });
    const nested = formattingRanges('- a\n  - b') ?? [];
    // The list, its item, the list inside the item, and its item: one level deeper each time.
    expect(nested.map((range) => range.depth)).toEqual([1, 2, 3, 4]);
  });
});
