/** Actual ESLint proves that partitioning keeps source coverage and cannot hide a failure. */
import { afterEach, expect, test } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  readFileSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { lintGroups, runLint, lintMain } from './lint-runner';

const roots: string[] = [];
const eslint = resolve(import.meta.dirname, '../node_modules/.bin/eslint');
const sources = [
  'apps/api/src/nested/file.js',
  'apps/new-workspace/untracked.js',
  'packages/new-package/file.js',
  'scripts/nested/file.js',
  'standalone.js',
] as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'purlay-lint-')));
  roots.push(root);
  const files = {
    ...Object.fromEntries(sources.map((source) => [source, 'export const value = 1;\n'])),
    'eslint.config.mjs':
      "export default [{ rules: { 'no-debugger': 'error', 'no-var': 'error' } }];\n",
    'node_modules/ignored.js': 'debugger;\n',
    '.git/ignored.js': 'debugger;\n',
    'docs/readme.md': '# Not JavaScript\n',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
};

const invoke = (root: string, args: readonly string[]): ReturnType<typeof Bun.spawnSync> =>
  Bun.spawnSync([eslint, ...args], { cwd: root, stdout: 'pipe', stderr: 'pipe' });

test('every existing, nested, new-workspace and root source is linted exactly once', () => {
  const root = fixture();
  const visited: string[] = [];
  const code = runLint(lintGroups(root, ['apps/*', 'packages/*']), ['--format', 'json'], (args) => {
    const result = invoke(root, args);
    expect(result.exitCode).toBe(0);
    if (result.stdout === undefined) throw new Error('ESLint produced no result report');
    const rows: unknown = JSON.parse(result.stdout.toString());
    if (!Array.isArray(rows)) throw new Error('ESLint did not return its result list');
    const entries: readonly unknown[] = rows;
    for (const row of entries) {
      if (typeof row !== 'object' || row === null || !('filePath' in row))
        throw new Error('ESLint result has no file path');
      if (typeof row.filePath !== 'string') throw new Error('ESLint file path is not text');
      visited.push(relative(root, row.filePath));
    }
    return result.exitCode;
  });
  expect(code).toBe(0);
  expect(visited.sort()).toEqual([...sources, 'eslint.config.mjs'].sort());
  expect(new Set(visited).size).toBe(visited.length);
});

test.each(['apps/api/src/nested/file.js', 'standalone.js'])(
  'an actual violation in %s fails the full command',
  (source) => {
    const root = fixture();
    writeFileSync(join(root, source), 'debugger;\n');
    const code = runLint(
      lintGroups(root, ['apps/*', 'packages/*']),
      [],
      (args) => invoke(root, args).exitCode,
    );
    expect(code).toBe(1);
  },
);

test('a killed child stops later work and preserves its failure status', () => {
  const visited: string[][] = [];
  const code = runLint([['apps/api'], ['apps/web']], ['--fix'], (args) => {
    visited.push([...args]);
    return 134;
  });
  expect(code).toBe(134);
  expect(visited).toHaveLength(1);
  expect(visited[0]).toContain('--fix');
});

const prepareRunner = (root: string): void => {
  mkdirSync(join(root, 'node_modules/.bin'));
  symlinkSync(eslint, join(root, 'node_modules/.bin/eslint'));
};

test('reporting flags are refused before an existing report can be overwritten', () => {
  const root = fixture();
  prepareRunner(root);
  const report = join(root, 'report.json');
  writeFileSync(report, 'previous report\n');
  const code = lintMain(
    root,
    ['apps/*', 'packages/*'],
    ['--format', 'json', '--output-file', report],
  );
  expect(code).toBe(2);
  expect(readFileSync(report, 'utf8')).toBe('previous report\n');
});

test('the supported fix command applies actual ESLint fixes', () => {
  const root = fixture();
  prepareRunner(root);
  writeFileSync(join(root, 'standalone.js'), 'var value = 1;\n');
  const code = lintMain(root, ['apps/*', 'packages/*'], ['--fix']);
  expect(code).toBe(0);
  expect(readFileSync(join(root, 'standalone.js'), 'utf8')).toMatch(/(?:let|const) value = 1;/u);
});
