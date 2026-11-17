import { describe, expect, test } from 'bun:test';
import { CORPUS, parseMarkdown } from '@purlay/markdown';
import { CellSelection } from 'prosemirror-tables';
import {
  originalRichSource,
  readRichDocument,
  richOffset,
  richSchema,
  writeRichDocument,
} from './rich-document';

describe('formatted editing uses the message grammar', () => {
  for (const { name, input } of CORPUS) {
    if (parseMarkdown(input) === null || input.length > 16000) continue;
    test(`retains the supported grammar: ${name}`, () => {
      const doc = readRichDocument(input);
      expect(readRichDocument(writeRichDocument(doc).text).eq(doc)).toBe(true);
    });
  }
  for (const text of [
    '',
    'Normal words',
    'İstanbul 🧑‍💻 yazı',
    '**bold** and _italic_ and ~~removed~~',
    '**bold _both_ bold**',
    '_italic **both** italic_',
    '**a**_b_**c**',
    '`code` and ``a`b`` and `` `padded` ``',
    '[label](https://example.com/a?q=1)',
    '[**bold** label](mailto:test@example.com)',
    '<script>alert(1)</script>',
    '\\*literal\\* \\_literal\\_ \\`code\\`',
    '# Title\n\n## Subtitle\n\n### Heading',
    '> quote\n>\n> second paragraph',
    '- one\n- two',
    '3. one\n4. two',
    '- [ ] pending\n- [x] done',
    '- one\n  - nested\n- two',
    '```ts\nconst a = `hello`;\n```',
    '````\n```\n````',
    '| First | Second |\n| :--- | ---: |\n| a | b |',
    'before\n\n---\n\nafter',
    'soft\nbreak  \nhard',
    'https://example.com/path and @alice',
  ]) {
    test(`preserves rendered content: ${JSON.stringify(text)}`, () => {
      const written = writeRichDocument(readRichDocument(text));
      expect(parseMarkdown(written.text)).toEqual(parseMarkdown(text));
    });
  }

  test('maps caret offsets through escaped punctuation and marks', () => {
    const doc = richSchema.node('doc', null, [
      richSchema.node('paragraph', null, [richSchema.text('a*b', [richSchema.mark('strong')])]),
    ]);
    const source = writeRichDocument(doc);
    expect(source.text).toBe('**a\\*b**');
    expect(source.positions.slice(1, 5)).toEqual([2, 3, 5, 8]);
    expect(richOffset(source, 4, [richSchema.mark('strong')])).toBe(6);
    expect(richOffset(source, 4, [])).toBe(8);
  });

  test('viewing noncanonical source preserves exact bytes and caret offsets', () => {
    const input = '__bold__ + *italic*';
    const source = originalRichSource(readRichDocument(input), input);
    expect(source?.text).toBe(input);
    expect(source?.positions[1]).toBe(2);
    if (source === null) throw new Error('Expected the source to be mapped');
    expect(richOffset(source, 5, [richSchema.mark('strong')])).toBe(6);
  });

  test('table cell selections always have finite source offsets', () => {
    const doc = readRichDocument('| A | B |\n|---|---|\n| a | b |');
    const selection = CellSelection.create(doc, 2, 7);
    const source = writeRichDocument(doc);
    expect(Number.isFinite(source.positions[selection.from])).toBe(true);
    expect(Number.isFinite(source.positions[selection.to])).toBe(true);
    expect(source.positions.every(Number.isFinite)).toBe(true);
  });

  test('a literal table pipe remains one code cell', () => {
    const doc = readRichDocument('| A |\n|---|\n| `a\\|b` |');
    const output = writeRichDocument(doc).text;
    expect(output).toContain('`a\\|b`');
    expect(readRichDocument(output).eq(doc)).toBe(true);
  });

  test('marked boundary whitespace stays outside delimiters', () => {
    const doc = richSchema.node('doc', null, [
      richSchema.node('paragraph', null, [richSchema.text(' hello ', [richSchema.mark('strong')])]),
    ]);
    expect(writeRichDocument(doc).text).toBe(' **hello** ');
  });

  for (const middle of ['b', 'b`c', ' b ']) {
    test(`emphasis crossing inline code retains literal content: ${middle}`, () => {
      const code = richSchema.mark('code');
      const doc = richSchema.node('doc', null, [
        richSchema.node('paragraph', null, [
          richSchema.text('a', [code]),
          richSchema.text(middle, [richSchema.mark('strong'), code]),
          richSchema.text('c', [code]),
        ]),
      ]);
      expect(readRichDocument(writeRichDocument(doc).text).eq(doc)).toBe(true);
    });
  }
});
