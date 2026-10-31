/**
 * What a paste becomes (D-210), on what people really paste: a spreadsheet's rows, a CSV, a page, a
 * Google Doc, an editor's coloured code — and what must stay as it was pasted.
 */
import { describe, expect, test } from 'bun:test';
import { parseMarkdown } from '@purlay/markdown';
import { installDom } from '../../testing/dom';
import { convertPaste, languageOf, markdownFromHtml, tableFromDelimited } from './paste';

installDom();

describe('a table from rows', () => {
  test('a spreadsheet’s copy (tabs) is a GFM table, the first row its header', () => {
    expect(tableFromDelimited('Region\tQ1\tQ2\nİstanbul\t12\t18\nAnkara\t7\t9\n')).toBe(
      [
        '| Region | Q1 | Q2 |',
        '| --- | --- | --- |',
        '| İstanbul | 12 | 18 |',
        '| Ankara | 7 | 9 |',
      ].join('\n'),
    );
  });

  test('a CSV keeps a quoted comma, a doubled quote and a line break inside one cell', () => {
    const csv = 'name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nLee,ok';
    expect(tableFromDelimited(csv)).toBe(
      [
        '| name | note |',
        '| --- | --- |',
        '| Smith, J | said "hi" then left |',
        '| Lee | ok |',
      ].join('\n'),
    );
  });

  test('a pipe in a cell is escaped, so it is not a column; an empty cell stays a cell', () => {
    expect(tableFromDelimited('a\tb\nx|y\t\n')).toBe(
      ['| a | b |', '| --- | --- |', '| x\\|y |   |'].join('\n'),
    );
  });

  test('semicolons, where the comma is the decimal mark', () => {
    expect(tableFromDelimited('ürün;fiyat\nçay;12,50\n')).toBe(
      ['| ürün | fiyat |', '| --- | --- |', '| çay | 12,50 |'].join('\n'),
    );
  });

  test.each([
    ['one line', 'a\tb\tc'],
    ['rows of different widths', 'a\tb\nc\nd\te'],
    ['one column', 'a\nb\nc'],
    [
      'prose with commas',
      'We shipped it, finally, after a long week of reviews and retries.\nThanks, everyone, for the patience you showed through all of it, really.',
    ],
    // A delimiter that ends or starts a line is punctuation, not a column: no header is blank.
    ['statements ended by semicolons', 'x = 1;\ny = 2;\nz = 3;'],
    ['rows ended by commas', '[1, 2],\n[3, 4],\n[5, 6],'],
  ])('%s is not a table', (_, pasted) => {
    expect(tableFromDelimited(pasted)).toBeNull();
  });

  test('more rows than a message should carry are left as they were pasted', () => {
    const rows = Array.from({ length: 300 }, (_, n) => `${String(n)}\tx`).join('\n');
    expect(tableFromDelimited(`id\tv\n${rows}`)).toBeNull();
  });
});

describe('what a paste becomes', () => {
  test('code is a block in its language, even when every line has one comma or ends in a semicolon', () => {
    const code = Array.from({ length: 13 }, (_, n) => `const x${String(n)} = call(a, "ğüş");`).join(
      '\n',
    );
    expect(convertPaste(code, '')).toEqual({
      kind: 'code',
      markdown: `\`\`\`js\n${code}\n\`\`\``,
      block: true,
    });
  });

  test('a paste that already is one fenced block is kept as supplied (D-205)', () => {
    const lines = Array.from({ length: 13 }, (_, n) => `line ${String(n)}`).join('\n');
    expect(convertPaste(`\`\`\`\n${lines}\n\`\`\``, '')).toBeNull();
  });
});

describe('the language of a pasted block', () => {
  test.each([
    ['json', '{\n  "name": "purlay",\n  "private": true\n}'],
    ['diff', 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b'],
    ['bash', '#!/usr/bin/env bash\nset -euo pipefail\necho hi'],
    ['bash', '$ bun install\n$ bun run dev'],
    ['sql', 'SELECT id, name\nFROM users\nWHERE active = true;'],
    ['python', 'import os\n\ndef main():\n    print(os.getcwd())'],
    ['go', 'package main\n\nfunc main() {\n\tx := 1\n}'],
    ['rust', 'fn main() {\n    let mut x = 1;\n    x += 1;\n}'],
    ['ts', 'export interface Policy {\n  readonly backoffMs: number;\n}'],
    ['tsx', 'export const A = (): JSX.Element => <Button size="sm" />;\ntype P = { a: string };'],
    ['js', 'const add = (a, b) => {\n  return a + b;\n};'],
    ['yaml', 'services:\n  api:\n    image: purlay\n    ports:\n      - 3000'],
    ['html', '<!doctype html>\n<html><body>hi</body></html>'],
    ['css', '.card {\n  color: red;\n}'],
  ])('%s', (language, code) => {
    expect(languageOf(code)).toBe(language);
  });

  test('words that are no language are not named one', () => {
    expect(languageOf('Release notes\n\nWe fixed the reconnect gap and the pool size.')).toBeNull();
    expect(languageOf('{ not json')).not.toBe('json');
  });
});

describe('formatted text as markdown', () => {
  test('a page’s emphasis, link, list, heading, quote and code', () => {
    const html = `
      <h2>Deploy notes</h2>
      <p>The <strong>pool</strong> is <em>bigger</em>, see <a href="https://example.com/pr/1">the PR</a> and <code>maxConn</code>.</p>
      <ul><li>first</li><li>second<ul><li>nested</li></ul></li></ul>
      <ol><li>one</li><li>two</li></ol>
      <blockquote><p>Measure first.</p></blockquote>
      <pre><code class="language-ts">const a = 1;</code></pre>`;
    expect(markdownFromHtml(html)).toBe(
      [
        '## Deploy notes',
        'The **pool** is _bigger_, see [the PR](https://example.com/pr/1) and `maxConn`.',
        '- first\n- second\n  - nested',
        '1. one\n2. two',
        '> Measure first.',
        '```ts\nconst a = 1;\n```',
      ].join('\n\n'),
    );
  });

  test('a Google Doc: its wrapper is bold in name only, and its bold and italic are styles', () => {
    const html =
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span style="font-weight:400;">Toplantı </span><span style="font-weight:700;">yarın</span><span style="font-weight:400;"> saat </span><span style="font-style:italic;">10:00</span></p></b>';
    expect(markdownFromHtml(html)).toBe('Toplantı **yarın** saat _10:00_');
  });

  test('a table copied from a page is a GFM table', () => {
    const html =
      '<table><tr><th>Name</th><th>Role</th></tr><tr><td>Alice</td><td>Owner</td></tr></table>';
    expect(markdownFromHtml(html)).toBe('| Name | Role |\n| --- | --- |\n| Alice | Owner |');
  });

  test('a backslash before a pipe in a cell’s code does not split the cell', () => {
    const html =
      '<table><tr><th>Shell</th><th>Note</th></tr><tr><td><code>a\\|b</code></td><td>C:\\dir|x</td></tr></table>';
    const markdown = markdownFromHtml(html) ?? '';
    expect(markdown).toBe('| Shell | Note |\n| --- | --- |\n| `a\\|b` | C:\\\\dir\\|x |');
    const table = parseMarkdown(markdown)?.children[0];
    expect(table?.type === 'table' ? table.children.map((row) => row.children.length) : []).toEqual(
      [2, 2],
    );
  });

  test('an editor’s coloured code has nothing to keep: the plain words are the paste', () => {
    const html =
      '<div style="color:#d4d4d4;background-color:#1e1e1e;"><div><span style="color:#569cd6;">const</span> a = 1;</div></div>';
    expect(markdownFromHtml(html)).toBeNull();
  });

  test('scripts are never run or kept, and only web and mail links are links', () => {
    const html =
      '<p><a href="javascript:alert(1)">click</a> <b>bold</b><script>window.pwned = true</script></p>';
    expect(markdownFromHtml(html)).toBe('click **bold**');
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
  });

  test('markdown characters in the words are words, not markdown', () => {
    expect(markdownFromHtml('<p><b>a*b_c</b> [x]</p>')).toBe('**a\\*b\\_c** \\[x\\]');
  });

  test('an image is its alt text; a deep heading is the third level; a line break is kept', () => {
    expect(markdownFromHtml('<h5>Deep</h5><p>one<br>two <img alt="chart"> <i>x</i></p>')).toBe(
      '### Deep\n\none\\\ntwo chart _x_',
    );
  });

  test('a page too large to read is left to its plain words', () => {
    expect(markdownFromHtml(`<b>x</b>${'<p>y</p>'.repeat(40_000)}`)).toBeNull();
  });
});
