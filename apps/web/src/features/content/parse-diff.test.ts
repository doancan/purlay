/**
 * Reading a pasted diff (#80, D-133): files and their paths, hunks and the numbers each line has on
 * each side, the counts, git's notes skipped, and a paste with no headers kept whole.
 */
import { describe, expect, test } from 'bun:test';
import { parseDiff, splitRows } from './parse-diff';

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
    const [hunk] = file?.hunks ?? [];
    expect(hunk?.header).toBe('@@ -10,4 +10,5 @@ export const retry = () => {');
    expect(hunk?.lines.map((l) => [l.kind, l.oldNumber, l.newNumber, l.text])).toEqual([
      ['context', 10, 10, 'const base = 1000;'],
      ['removed', 11, null, 'const cap = 4000;'],
      ['added', null, 11, 'const cap = 8000;'],
      ['added', null, 12, 'const jitter = 0.2;'],
      ['context', 12, 13, 'return Math.min(cap, base * 2 ** n);'],
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
    expect(diff.files[1]?.hunks[0]?.lines.map((l) => l.newNumber)).toEqual([1, 2]);
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
      ['context', 'not marked', null, null],
    ]);
  });

  test('a Windows paste reads the same', () => {
    expect(parseDiff(GIT.replace(/\n/g, '\r\n')).files[0]?.hunks[0]?.lines).toHaveLength(5);
  });

  test('nothing is an empty diff', () => {
    expect(parseDiff('')).toEqual({ files: [], added: 0, removed: 0 });
  });
});

describe('a hunk side by side', () => {
  test('pairs each run of removals with the additions after it, the rest against nothing', () => {
    const lines = parseDiff(GIT).files[0]?.hunks[0]?.lines ?? [];
    const rows = splitRows(lines).map((row) => [row.old?.text ?? null, row.new?.text ?? null]);
    expect(rows).toEqual([
      ['const base = 1000;', 'const base = 1000;'],
      ['const cap = 4000;', 'const cap = 8000;'],
      [null, 'const jitter = 0.2;'],
      ['return Math.min(cap, base * 2 ** n);', 'return Math.min(cap, base * 2 ** n);'],
    ]);
  });

  test('more removed than added leaves the old side longer', () => {
    const rows = splitRows(parseDiff('-a\n-b\n+c').files[0]?.hunks[0]?.lines ?? []);
    expect(rows.map((row) => [row.old?.text ?? null, row.new?.text ?? null])).toEqual([
      ['a', 'c'],
      ['b', null],
    ]);
  });
});
