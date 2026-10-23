/**
 * Tests, the demo, the browser suite and the budgets never read the developer's `.env`.
 *
 * Bun loads `.env` from the working directory into every process it starts — the test runner, and each
 * `bun` a test or a script starts in turn. So a machine with a `.env` ran everything against its own
 * `ENCRYPTION_KEY`, its own bucket and its own `DATABASE_URL`, and a suite that was green in CI failed
 * there for reasons that were no defect: the demo's sessions were signed with one key and served with
 * another, the browser suite's server wrote to a real bucket, "without a database" found one. Each was
 * found by hand, after it had cost an afternoon.
 *
 * A rule held by remembering is a wish (`CONTRIBUTING.md` §6.2). The rule is: **a `bun` these start
 * says `--no-env-file`.** What a run is meant to read — the test database's address — is `.env.test`,
 * named out loud (`--env-file=.env.test`), which a clone does not have and CI does not need. This test
 * is the mechanism: it reads every place that starts one and refuses the place that forgot.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const FLAG = '--no-env-file';

/**
 * The `bun` processes a source text starts that read the repository's `.env` unless told not to: an
 * array that begins with `'bun'` and runs a script, a test or `-e` (not a tool — `bun x`, `bun audit`).
 * Each is returned as the text of its array, for the message.
 */
export const unhermeticSpawns = (text: string): string[] => {
  const found: string[] = [];
  for (const match of text.matchAll(/\[\s*'bun'\s*,([^\]]*)\]|'bun'\s*,\s*\[([^\]]*)\]/g)) {
    const args = match[1] ?? match[2] ?? '';
    const head = /^\s*'([^']*)'/.exec(args)?.[1] ?? '';
    if (['x', 'audit', FLAG].includes(head)) continue;
    if (args.includes(FLAG)) continue;
    found.push(match[0].replace(/\s+/g, ' ').slice(0, 110));
  }
  return found;
};

describe('the detector', () => {
  test('refuses a bun that runs a script, a test or code, however the call is written', () => {
    expect(unhermeticSpawns("Bun.spawn(['bun', 'run', 'apps/api/src/index.ts'])")).toHaveLength(1);
    expect(unhermeticSpawns("Bun.spawnSync(['bun', 'test', ...args])")).toHaveLength(1);
    expect(unhermeticSpawns("Bun.spawn(['bun', '-e', script])")).toHaveLength(1);
    expect(unhermeticSpawns("Bun.spawn(['bun', entry], { cwd })")).toHaveLength(1);
    expect(unhermeticSpawns("await run('bun', ['run', 'cli.ts', '--new', name])")).toHaveLength(1);
    expect(
      unhermeticSpawns("spawn(\n    'bun',\n    [\n      'run',\n      'x.ts',\n    ],\n  )"),
    ).toHaveLength(1);
  });

  test('lets through one that says so, and a tool that is not a script', () => {
    expect(unhermeticSpawns("Bun.spawn(['bun', '--no-env-file', 'run', 'a.ts'])")).toEqual([]);
    expect(unhermeticSpawns("run('bun', ['--no-env-file', 'run', 'cli.ts'])")).toEqual([]);
    expect(unhermeticSpawns("Bun.spawnSync(['bun', 'x', 'knip', '--reporter', 'json'])")).toEqual(
      [],
    );
    expect(unhermeticSpawns("Bun.spawnSync(['bun', 'audit', '--json'])")).toEqual([]);
  });
});

const sources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    if (
      ['node_modules', '.git', 'dist', '.tsbuild', 'coverage', '.playwright-mcp'].includes(name)
    ) {
      return [];
    }
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });

/**
 * Where a `bun` is *meant* to read `.env`: starting the development servers, which is what `.env` is for.
 * Named, so that adding to it is a decision somebody can read.
 */
const READS_DOT_ENV_ON_PURPOSE = ['scripts/dev.ts', 'scripts/hermetic.test.ts'];

describe('the repository', () => {
  test('starts no bun from a test, a script or the browser suite that would read the developer’s .env', () => {
    const unhermetic: string[] = [];
    for (const path of sources(root)) {
      const name = relative(root, path);
      if (READS_DOT_ENV_ON_PURPOSE.includes(name)) continue;
      for (const spawn of unhermeticSpawns(readFileSync(path, 'utf8'))) {
        unhermetic.push(`${name}: ${spawn}`);
      }
    }
    expect(unhermetic).toEqual([]);
  });

  test('has no script in package.json that runs the tests, the demo, the browser suite or a budget without it', () => {
    const scripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const runsHermetic =
      /(^|&& |\| )bun (test|run scripts\/(demo|test-all|budget-)|run apps\/api\/src\/cli\/budget-|run --filter @purlay\/web e2e)/;
    const lacking = Object.entries(scripts)
      .filter(([, command]) => runsHermetic.test(command) && !command.includes(FLAG))
      .map(([name, command]) => `${name}: ${command}`);
    expect(lacking).toEqual([]);
  });

  test('names the one file a hermetic run does read: the test database’s address, in .env.test', () => {
    const scripts = (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    for (const name of ['test', 'test:integration', 'test:e2e', 'demo']) {
      expect([name, scripts[name]?.includes('--env-file=.env.test')]).toEqual([name, true]);
    }
  });
});
