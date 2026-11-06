/**
 * What a paste is, by its shape (D-259): each recogniser on what people really paste, and — as much —
 * on what they write that only looks like code. A miss costs nothing; a wrong conversion costs a step.
 */
import { describe, expect, test } from 'bun:test';
import { installDom } from '../../../testing/dom';
import { convertPaste, fileOfferFor } from './paste';
import {
  isSingleLineCode,
  linkOverSelection,
  listFromPlain,
  looksLikeMarkdown,
  pastedFiles,
  shortBlockLanguage,
} from './paste-shapes';

installDom();

const NOW = new Date(2026, 10, 5, 14, 32, 7);

describe('a single line of code', () => {
  test.each([
    'git rebase -i HEAD~3',
    'git status',
    'docker compose up -d',
    'ssh deploy@10.0.0.119',
    'curl -fsSL https://example.com/install.sh',
    '$ ./deploy.sh',
    'sudo apt install nginx',
    'kubectl logs api-0 | tail -n 100',
    '$ bun run verify',
    'sudo systemctl restart purlay',
    'apps/api/src/retry.ts:14',
    'src/x.ts:14:5',
    'DATABASE_URL=postgres://localhost/db',
    'const retries = 3;',
    "import { x } from './x';",
    'console.log(value);',
    'SELECT id FROM users WHERE id = 1;',
  ])('%s is inline code', (line) => {
    expect(isSingleLineCode(line)).toBe(true);
  });

  test.each([
    'git is great',
    'git gud.',
    'see src/x.ts:14 for the retry',
    'Please export the report (final) by Friday;',
    'TR12 0006 4000 0011 2345 6789 01',
    '1.234,56',
    '₺1.250,00',
    'Owner: Ali',
    'select one from the list where possible',
    'FOO=bar yapmayı dene',
    // Program names are words too: Turkish "git" is "go", and these are English verbs.
    'git bana bak',
    'git eve',
    'git şuraya bak',
    'docker nedir',
    'brew coffee',
    'ssh into prod and restart it',
    'curl up with a book',
    '$ 50 for lunch',
    '$ price list',
    'İş bitti',
    'ılık çay',
    'a line with `ticks` inside',
    'x'.repeat(250),
  ])('%s stays words', (line) => {
    expect(isSingleLineCode(line)).toBe(false);
  });
});

describe('a short block of code', () => {
  test('JSON, SQL, Go and Python are fenced in their language', () => {
    expect(convertPaste('{\n  "a": 1,\n  "b": [1, 2]\n}', '')?.markdown).toBe(
      '```json\n{\n  "a": 1,\n  "b": [1, 2]\n}\n```',
    );
    expect(convertPaste('SELECT id\nFROM users\nWHERE id = 1;', '')?.markdown).toStartWith(
      '```sql\n',
    );
    expect(convertPaste('def f(x):\n    return x + 1', '')?.markdown).toStartWith('```python\n');
  });

  test('a stack trace is a block with no language', () => {
    const trace =
      'TypeError: x is undefined\n    at run (/app/src/a.ts:10:5)\n    at main (/app/src/b.ts:3:1)';
    expect(convertPaste(trace, '')).toEqual({
      kind: 'code',
      markdown: `\`\`\`\n${trace}\n\`\`\``,
      block: true,
    });
  });

  test.each([
    ['chat lines that look like YAML', 'Owner: Ali\nDue: Friday'],
    [
      'a sentence with import and return in it',
      'Please import the file (see below)\nand return it',
    ],
    ['a short list', '- milk\n- bread'],
    ['two lines of prose', 'Hello team,\nthe deploy is done.'],
    ['a request that begins like SQL', 'Select one from the menu\nand tell me'],
    ['an update that begins like SQL', 'Update on the release:\nwe ship Friday'],
    ['a delete that is a sentence', 'Delete from the list\nthe old ones'],
    ['a courier who says package', 'The courier called\npackage arrived'],
    ['prices with a dollar sign', 'Prices:\n$ 50 lunch\n$ 20 taxi'],
  ])('%s is left alone', (_name, text) => {
    expect(convertPaste(text, '')).toBeNull();
  });

  test('SQL, Go and a shell are fenced only when each is certain', () => {
    expect(convertPaste('SELECT id\nFROM users\nWHERE id = 1;', '')?.markdown).toStartWith(
      '```sql',
    );
    expect(convertPaste('package main\n\nfunc main() {\n}', '')?.markdown).toStartWith('```go');
    expect(convertPaste('$ git status\n$ git log -3', '')?.markdown).toStartWith('```bash');
    expect(convertPaste('#!/bin/bash\necho hi', '')?.markdown).toStartWith('```bash');
  });

  test('YAML is never certain in a few lines, JavaScript needs a line that is code', () => {
    expect(shortBlockLanguage('a: 1\nb: 2', 'yaml')).toBeNull();
    expect(shortBlockLanguage('return it\nexport (the file)', 'js')).toBeNull();
    expect(shortBlockLanguage('const a = 1;\nexport default a;', 'js')).toBe('js');
  });
});

describe('markdown', () => {
  const note = '# Weekly\n\n- shipped the **editor**\n- fixed the [bug](https://x.test/1)\n';

  test('Markdown someone wrote is not turned into a code block, long or short', () => {
    expect(looksLikeMarkdown(note)).toBe(true);
    expect(convertPaste(note, '')).toBeNull();
    const long = `${note}${'- more words here\n'.repeat(30)}`;
    expect(convertPaste(long, '')).toBeNull();
  });

  test('a shell script with # comments is code, not headings', () => {
    const script = `#!/bin/bash\n# build\n${'echo step\n'.repeat(14)}`;
    expect(looksLikeMarkdown(script)).toBe(false);
    expect(convertPaste(script, '')?.kind).toBe('code');
  });

  test('a table is a signal with another: two kinds make Markdown, one does not', () => {
    expect(looksLikeMarkdown('# Only a heading')).toBe(false);
    expect(looksLikeMarkdown('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n**done**')).toBe(true);
  });
});

describe('a link over selected words', () => {
  test('is the words’ link; over nothing, a URL is a URL', () => {
    expect(linkOverSelection('https://x.test/offer', 'the offer')).toBe(
      '[the offer](https://x.test/offer)',
    );
    expect(linkOverSelection('https://x.test/offer', '')).toBeNull();
    expect(linkOverSelection('see https://x.test', 'words')).toBeNull();
    expect(linkOverSelection('https://x.test', 'a [b]')).toBeNull();
    expect(linkOverSelection('https://x.test', 'two\nlines')).toBeNull();
  });

  test('through the conversion, as a step Undo can take back', () => {
    expect(convertPaste('https://x.test/o', '', 'offer')).toEqual({
      kind: 'link',
      markdown: '[offer](https://x.test/o)',
      block: false,
    });
  });
});

describe('a very long text, or a table too large to be a message', () => {
  test('under the lines it is a message; over, a file named for its minute and content', () => {
    expect(fileOfferFor('x\n'.repeat(499), NOW)).toBeNull();
    const words = fileOfferFor('word word\n'.repeat(600), NOW);
    expect(words).toMatchObject({ name: 'pasted-20261105-1432.txt', lines: 600 });
    const markdown = fileOfferFor(`# Notes\n\n- **a**\n- b\n${'text\n'.repeat(600)}`, NOW);
    expect(markdown).toMatchObject({
      name: 'pasted-20261105-1432.md',
      type: 'text/markdown',
      lines: 604,
    });
    const code = fileOfferFor(`{\n${'"a": 1,\n'.repeat(600)}"z": 0\n}`, NOW);
    expect(code).toMatchObject({ name: 'pasted-20261105-1432.json', lines: 603 });
  });

  test('a text over what a message may hold is offered even in a few lines', () => {
    expect(fileOfferFor('x'.repeat(16_001), NOW)?.name).toBe('pasted-20261105-1432.txt');
  });

  test('more than 200 rows are offered as a CSV that Excel opens, quoted where it must be', () => {
    const rows = [
      'name\tnote',
      ...Array.from({ length: 250 }, (_, at) => `n${String(at)}\ta, "b"`),
    ];
    const offer = fileOfferFor(rows.join('\n'), NOW);
    expect(offer).toMatchObject({ name: 'pasted-20261105-1432.csv', type: 'text/csv' });
    expect(offer?.text.split('\n')[0]).toBe('name,note');
    expect(offer?.text.split('\n')[1]).toBe('n0,"a, ""b"""');
  });
});

describe('the clipboard’s files', () => {
  const picture = (name: string): File => new File(['x'], name, { type: 'image/png' });

  test('a screenshot has no words: it is uploaded, named for the second it was pasted', () => {
    const [file] = pastedFiles([picture('image.png')], '', NOW);
    expect(file?.name).toBe('pasted-image-20261105-143207.png');
    expect(file?.type).toBe('image/png');
  });

  test('two clipboard pictures never share a name', () => {
    const names = pastedFiles([picture('image.png'), picture('image.png')], '', NOW).map(
      (file) => file.name,
    );
    expect(new Set(names).size).toBe(2);
  });

  test('a spreadsheet’s range comes with a picture of itself: its words are what was copied', () => {
    expect(pastedFiles([picture('image.png')], 'a\tb\n1\t2', NOW)).toEqual([]);
  });

  test('a file copied in the Finder or the Explorer keeps its own name, whatever words come with it', () => {
    const photo = picture('IMG_2041.png');
    expect(pastedFiles([photo], 'IMG_2041.png', NOW)).toEqual([photo]);
    expect(pastedFiles([photo], '', NOW)).toEqual([photo]);
    const same = picture('image.png');
    expect(pastedFiles([same], 'image.png', NOW)[0]?.name).toBe('image.png');
  });
});

describe('numbers in a table', () => {
  test('a column of numbers is aligned to the right and its words are untouched', () => {
    const table = convertPaste('Hesap\tTutar\tKod\n102\t1.234,56\t0120\n320\t(500)\t0007', '');
    expect(table?.markdown).toBe(
      [
        '| Hesap | Tutar | Kod |',
        '| ---: | ---: | ---: |',
        '| 102 | 1.234,56 | 0120 |',
        '| 320 | (500) | 0007 |',
      ].join('\n'),
    );
  });

  test('a column with a word in it stays left', () => {
    const table = convertPaste('Ad\tNot\nAli\t12\nVeli\tyok', '');
    expect(table?.markdown).toContain('| --- | --- |');
  });
});

describe('input that is hostile to a pattern (the box takes up to 16,000 characters from anyone)', () => {
  const size = 16_000;
  const shapes: readonly (readonly [string, string])[] = [
    ['one long word', 'x'.repeat(size)],
    ['spaces', ' '.repeat(size)],
    ['an open brace and words', `{${'a '.repeat(size / 2)}`],
    ['braces, no rule', `a {${'b: c '.repeat(size / 5)}`],
    ['colons', 'a:'.repeat(size / 2)],
    ['commas', 'a,'.repeat(size / 2)],
    ['tags', '<a>'.repeat(size / 3)],
    ['many short lines', 'x\n'.repeat(size / 2)],
    ['dashes and digits', '- 1. '.repeat(size / 5)],
    ['hashes', '# '.repeat(size / 2)],
    ['brackets', '[a]('.repeat(size / 4)],
    ['stars', '**a '.repeat(size / 4)],
    ['open brackets', '['.repeat(size)],
    ['rules never closed', 'a{\n'.repeat(size / 3)],
    ['braces and one close', `${'a{\n'.repeat(size / 3)}}`],
    ['sql words', 'SELECT '.repeat(size / 7)],
  ];

  test.each(shapes)('%s is read in a time a person does not notice', (_name, text) => {
    const started = performance.now();
    convertPaste(text, '');
    fileOfferFor(text, NOW);
    isSingleLineCode(text);
    looksLikeMarkdown(text);
    // A pattern that backtracks takes minutes at this size; a CI machine's noise is seconds at worst.
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe('a list copied as plain words (D-259)', () => {
  test('bullets, boxes and counted 1) 2) 3) are a Markdown list; the lines around it are kept', () => {
    expect(listFromPlain('Shopping:\n• milk\n• bread\n  ◦ rye')).toBe(
      'Shopping:\n\n- milk\n- bread\n  - rye',
    );
    expect(listFromPlain('☐ call the bank\n☑ send the invoice\n✅ close the month')).toBe(
      '- [ ] call the bank\n- [x] send the invoice\n- [x] close the month',
    );
    expect(listFromPlain('1) open the file\n2) check it\n3) send it')).toBe(
      '1. open the file\n2. check it\n3. send it',
    );
    expect(listFromPlain('• one\n• two\nThat is all.')).toBe('- one\n- two\n\nThat is all.');
  });

  test.each([
    ['a dialogue’s dashes', '– Where are you?\n– At home.\n– Come over.'],
    ['numbers out of order, as a sentence has them', '2) it is late\n5) it is far'],
    ['one bullet', '• only one'],
    [
      'a stray bullet in prose',
      'A long line of words.\nAnother long line of words.\n• one\nThe last line.',
    ],
    ['Markdown that is already a list', '- one\n- two'],
  ])('%s is left alone', (_name, text) => {
    expect(listFromPlain(text)).toBeNull();
  });

  test('through the conversion, as a block with its own toast kind; code is never a list', () => {
    expect(convertPaste('• a\n• b', '')).toEqual({
      kind: 'list',
      markdown: '- a\n- b',
      block: true,
    });
    expect(convertPaste('const a = 1;\n• b\n• c', '')?.kind).not.toBe('list');
  });
});
