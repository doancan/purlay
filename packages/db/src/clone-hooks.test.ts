/**
 * Every hook that clones the integration template is given `CLONE_HOOK_MS` (D-228), and every hook that
 * drops clones at least `DROP_HOOK_MS` (#797): with the default five seconds, a clone waiting its turn
 * behind the other worker's, or drops waiting for their checkpoints, failed files whose tests had all
 * passed. A file added later is held to it here, not by somebody remembering.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DROP_HOOK_MS } from './testing';

const ROOT = join(import.meta.dir, '../../..');

/** Each hook of a kind in a file, as the text from its opening line to its closing one, at its own indent. */
const hooksOf = (text: string, kind = 'beforeAll|beforeEach'): readonly string[] =>
  [
    ...text.matchAll(
      new RegExp(
        `^([ \\t]*)(?:${kind})\\(async \\(\\) => \\{\\n[\\s\\S]*?\\n\\1\\}[^\\n]*\\);$`,
        'gm',
      ),
    ),
  ].map((match) => match[0]);

/**
 * What a hook waits on the database or a connection for: a drop (a clone's own, one passed around by name, several at
 * once, or a schema), a pool that is let go, and a wait for sockets to be forgotten. Each is as slow as the machine is
 * busy, so each is given the time drops wait for (`DROP_HOOK_MS`).
 */
const DROPS = /\.drop\(\)|await drop\(\)|dropDatabases\(|drop schema|\.destroy\(\)|\buntil\(/;

/** The hooks that end a test or a file, which is where a drop or a wait for connections is. */
const ENDING = 'afterAll|afterEach';

/** Whether a hook's closing gives it at least `DROP_HOOK_MS`, by name or as a longer number. */
const timedForDrops = (hook: string): boolean => {
  const bound = /\}, ([\w_]+)\);$/.exec(hook)?.[1];
  if (bound === undefined) return false;
  return bound === 'DROP_HOOK_MS' || Number(bound.replaceAll('_', '')) >= DROP_HOOK_MS;
};

/** Scan the same source roots as Bun, including new files before their first commit. */
const integrationFiles = (root = ROOT): readonly string[] => {
  const filesIn = (directory: string): readonly string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === 'node_modules') return [];
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return filesIn(path);
      return entry.isFile() && path.endsWith('.integration.test.ts') ? [relative(root, path)] : [];
    });
  return ['apps', 'packages', 'scripts'].flatMap((path) => filesIn(join(root, path))).toSorted();
};

describe('a hook that clones the template has the time a clone waits for', () => {
  test('the reader finds a hook and its closing, at its own indent', () => {
    const text = [
      'beforeAll(async () => {',
      '  a = await cloneIntegrationDatabase();',
      '}, CLONE_HOOK_MS);',
      'describe("x", () => {',
      '  beforeAll(async () => {',
      '    b = 1;',
      '  });',
      '});',
    ].join('\n');
    expect(hooksOf(text)).toEqual([
      'beforeAll(async () => {\n  a = await cloneIntegrationDatabase();\n}, CLONE_HOOK_MS);',
      '  beforeAll(async () => {\n    b = 1;\n  });',
    ]);
  });

  test('includes a new integration file before it has been added to Git', () => {
    const root = mkdtempSync(join(tmpdir(), 'purlay-clone-hooks-'));
    try {
      expect(Bun.spawnSync(['git', 'init', '--quiet', root]).exitCode).toBe(0);
      for (const path of ['apps/api/src', 'packages/db/src', 'scripts/node_modules/vendor']) {
        mkdirSync(join(root, path), { recursive: true });
      }
      writeFileSync(join(root, 'apps/api/src/new.integration.test.ts'), 'new fixture');
      writeFileSync(
        join(root, 'scripts/node_modules/vendor/ignored.integration.test.ts'),
        'dependency',
      );
      expect(integrationFiles(root)).toEqual(['apps/api/src/new.integration.test.ts']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('in every integration test file', () => {
    const files = integrationFiles();
    expect(files.length).toBeGreaterThan(50);
    const short = files.filter((file) =>
      hooksOf(readFileSync(join(ROOT, file), 'utf8')).some(
        (hook) => hook.includes('cloneIntegrationDatabase(') && !hook.endsWith(', CLONE_HOOK_MS);'),
      ),
    );
    expect(short).toEqual([]);
  });

  test('every hook that drops, lets a pool go or waits for connections has at least the time drops wait for', () => {
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, DROP_HOOK_MS);')).toBe(
      true,
    );
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, 120_000);')).toBe(
      true,
    );
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, 5_000);')).toBe(false);
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n});')).toBe(false);
    for (const waits of [
      'await sql`drop schema ${name} cascade`.execute(db);',
      'await database.destroy();',
      "await until('every socket to be forgotten', done);",
    ]) {
      expect(DROPS.test(`afterEach(async () => {\n  ${waits}\n});`)).toBe(true);
    }
    const short = integrationFiles().filter((file) =>
      hooksOf(readFileSync(join(ROOT, file), 'utf8'), ENDING).some(
        (hook) => DROPS.test(hook) && !timedForDrops(hook),
      ),
    );
    expect(short).toEqual([]);
  });
});
