/**
 * Reading a pasted diff (#80, D-133): files and their paths, hunks and the numbers each line has on
 * each side, the counts, git's notes kept as notes, and nothing pasted ever lost.
 */
import { describe, expect, test } from 'bun:test';
import { parseDiff, splitRows, type SplitRow } from './parse-diff';

const GIT = [
  'diff --git a/src/retry.ts b/src/retry.ts',
  'index 3f2a1b0..9c8d7e6 100644',
  '--- a/src/retry.ts',
  '+++ b/src/retry.ts',
  '@@ -10,4 +10,5 @@ export const retry = () => {',
  ' const base = 1000;',
  '-const cap = 4000;',
  '+const cap = 8000;',
  '+const jitter = 0.2;',
  ' return Math.min(cap, base * 2 ** n);',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('a diff, read', () => {
  test('knows its file, its hunk, and each line’s numbers on each side', () => {
    const diff = parseDiff(GIT);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.files).toHaveLength(1);
    const [file] = diff.files;
    expect([file?.oldPath, file?.newPath]).toEqual(['src/retry.ts', 'src/retry.ts']);
    const [notes, hunk] = file?.hunks ?? [];
    expect(notes?.lines.map((l) => [l.kind, l.text])).toEqual([
      ['note', 'index 3f2a1b0..9c8d7e6 100644'],
    ]);
    expect(hunk?.header).toBe('@@ -10,4 +10,5 @@ export const retry = () => {');
    expect(hunk?.lines.map((l) => [l.kind, l.oldNumber, l.newNumber, l.text])).toEqual([
      ['context', 10, 10, 'const base = 1000;'],
      ['removed', 11, null, 'const cap = 4000;'],
      ['added', null, 11, 'const cap = 8000;'],
      ['added', null, 12, 'const jitter = 0.2;'],
      ['context', 12, 13, 'return Math.min(cap, base * 2 ** n);'],
      ['note', null, null, '\\ No newline at end of file'],
    ]);
  });

  test('two files are two files, a new one with no old path', () => {
    const diff = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1 +1 @@',
        '-x',
        '+y',
        'diff --git a/new.ts b/new.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/new.ts',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
      ].join('\n'),
    );
    expect(diff.files.map((f) => [f.oldPath, f.newPath])).toEqual([
      ['a.ts', 'a.ts'],
      [null, 'new.ts'],
    ]);
    expect(diff.files[1]?.hunks[1]?.lines.map((l) => l.newNumber)).toEqual([1, 2]);
    expect([diff.added, diff.removed]).toEqual([3, 1]);
  });

  test('a paste of + and - lines with no headers is one hunk with no numbers, nothing lost', () => {
    const diff = parseDiff('-old\n+new\n same\nnot marked');
    const lines = diff.files[0]?.hunks[0]?.lines ?? [];
    expect(diff.files[0]?.hunks[0]?.header).toBeNull();
    expect(lines.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['removed', 'old', null, null],
      ['added', 'new', null, null],
      ['context', 'same', null, null],
      ['note', 'not marked', null, null],
    ]);
  });

  test('a Windows paste reads the same', () => {
    expect(parseDiff(GIT.replace(/\n/g, '\r\n'))).toEqual(parseDiff(GIT));
  });

  test('nothing is an empty diff', () => {
    expect(parseDiff('')).toEqual({ files: [], added: 0, removed: 0 });
  });

  test('diff -u of two files, with no diff --git: each hunk ends where its header says', () => {
    const diff = parseDiff(
      [
        '--- a/x',
        '+++ b/x',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '--- a/y',
        '+++ b/y',
        '@@ -1 +1 @@',
        '-c',
        '+d',
      ].join('\n'),
    );
    expect(diff.files.map((f) => [f.newPath, f.hunks[0]?.lines.map((l) => l.text)])).toEqual([
      ['x', ['a', 'b']],
      ['y', ['c', 'd']],
    ]);
  });

  test('a removed line that begins with -- inside a hunk is a removed line, not a header', () => {
    const lines = parseDiff('@@ -1,2 +1,1 @@\n--- a comment\n x').files[0]?.hunks[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['removed', '-- a comment', 1, null],
      ['context', 'x', 2, 1],
    ]);
  });

  test('a blank context line is a line, at the end of a hunk too', () => {
    const lines = parseDiff('@@ -1,2 +1,2 @@\n-a\n+b\n\n').files[0]?.hunks[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['removed', 'a', 1, null],
      ['added', 'b', null, 1],
      ['context', '', 2, 2],
    ]);
  });

  test('a rename, a copy or a binary file, with no hunk, is still a file, said in notes', () => {
    const diff = parseDiff(
      [
        'diff --git a/old.ts b/new.ts',
        'similarity index 100%',
        'rename from old.ts',
        'rename to new.ts',
        'diff --git a/i.png b/i.png',
        'Binary files a/i.png and b/i.png differ',
      ].join('\n'),
    );
    expect(
      diff.files.map((f) => [
        f.oldPath,
        f.newPath,
        f.hunks.flatMap((h) => h.lines.map((l) => l.kind)),
      ]),
    ).toEqual([
      ['old.ts', 'new.ts', ['note', 'note', 'note']],
      ['i.png', 'i.png', ['note']],
    ]);
  });

  test('prose before, between and after the hunks is kept as notes, never numbered', () => {
    const diff = parseDiff('Here is the fix:\n@@ -1 +1 @@\n-a\n+b\nThanks!');
    const all = diff.files.flatMap((f) => f.hunks.flatMap((h) => h.lines));
    expect(all.map((l) => [l.kind, l.text, l.oldNumber, l.newNumber])).toEqual([
      ['note', 'Here is the fix:', null, null],
      ['removed', 'a', 1, null],
      ['added', 'b', null, 1],
      ['note', 'Thanks!', null, null],
    ]);
  });

  test('after prose, a --- line is a removed line: only diff --git may skip to its paths', () => {
    const lines = parseDiff('notes:\n--- x\n+ y').files[0]?.hunks[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.text])).toEqual([
      ['note', 'notes:'],
      ['removed', '-- x'],
      ['added', ' y'],
    ]);
  });

  test('--- and +++ with no hunk after them, outside git, are lines, not headers', () => {
    const lines = parseDiff('--- drop this\n+++ add that\n same').files[0]?.hunks[0]?.lines;
    expect(lines?.map((l) => [l.kind, l.text])).toEqual([
      ['removed', '-- drop this'],
      ['added', '++ add that'],
      ['context', 'same'],
    ]);
  });
});

/** The diff written back out: what the viewer draws, line for line, headers aside. */
const rebuild = (text: string): string[] =>
  parseDiff(text).files.flatMap((file) =>
    file.hunks.flatMap((hunk) => [
      ...(hunk.header === null ? [] : [hunk.header]),
      ...hunk.lines.map((line) =>
        line.kind === 'note'
          ? line.text
          : `${{ added: '+', removed: '-', context: ' ' }[line.kind]}${line.text}`,
      ),
    ]),
  );

describe('nothing pasted is lost', () => {
  const PROBES = [
    GIT,
    'diff --git a/a b/c\nsimilarity index 90%\ncopy from a\ncopy to c\n--- a/a\n+++ b/c\n@@ -1 +1 @@\n-x\n+y',
    '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+c\n\nprose\n--- a/y\n+++ b/y\n@@ -2 +2 @@\n-d\n+e',
    '@@ -1,2 +1,1 @@\n--- a comment\n x\nafter',
    'just prose\n-and a dash',
    '@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n\\ No newline at end of file',
  ];
  test.each(PROBES)('every line but a file header is drawn, in order: %#', (probe) => {
    const header = /^(diff --git |--- (a\/|\/dev\/null)|\+\+\+ (b\/|\/dev\/null))/;
    // The paste's own last line break ends its last line; it is not a line of its own.
    const pasted = probe
      .replace(/\n$/, '')
      .split('\n')
      .filter((line) => !header.test(line));
    // A blank line inside a hunk is context with nothing on it: drawn as one space.
    expect(rebuild(probe).map((line) => line.trimEnd())).toEqual(
      pasted.map((line) => line.trimEnd()),
    );
  });
});

const sides = (row: SplitRow): (string | null)[] =>
  row.kind === 'note' ? [row.line.text] : [row.old?.text ?? null, row.new?.text ?? null];

describe('a hunk side by side', () => {
  test('pairs each run of removals with the additions after it, the rest against nothing', () => {
    const lines = parseDiff(GIT).files[0]?.hunks[1]?.lines ?? [];
    expect(splitRows(lines).map(sides)).toEqual([
      ['const base = 1000;', 'const base = 1000;'],
      ['const cap = 4000;', 'const cap = 8000;'],
      [null, 'const jitter = 0.2;'],
      ['return Math.min(cap, base * 2 ** n);', 'return Math.min(cap, base * 2 ** n);'],
      // A note is about the lines, not one side: a row across both.
      ['\\ No newline at end of file'],
    ]);
  });

  test('more removed than added leaves the old side longer', () => {
    const rows = splitRows(parseDiff('-a\n-b\n+c').files[0]?.hunks[0]?.lines ?? []);
    expect(rows.map(sides)).toEqual([
      ['a', 'c'],
      ['b', null],
    ]);
  });
});
