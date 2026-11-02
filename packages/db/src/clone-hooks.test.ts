/**
 * Every hook that clones the integration template is given `CLONE_HOOK_MS` (D-228), and every hook that
 * drops clones at least `DROP_HOOK_MS` (#797): with the default five seconds, a clone waiting its turn
 * behind the other worker's, or drops waiting for their checkpoints, failed files whose tests had all
 * passed. A file added later is held to it here, not by somebody remembering.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DROP_HOOK_MS } from './testing';

const ROOT = join(import.meta.dir, '../../..');

/** Each hook of a kind in a file, as the text from its opening line to its closing one, at its own indent. */
const hooksOf = (text: string, kind = 'beforeAll'): readonly string[] =>
  [
    ...text.matchAll(
      new RegExp(`^([ \\t]*)${kind}\\(async \\(\\) => \\{\\n[\\s\\S]*?\\n\\1\\}[^\\n]*\\);$`, 'gm'),
    ),
  ].map((match) => match[0]);

/** A drop: a clone's own, one passed around by name, or several at once. */
const DROPS = /\.drop\(\)|await drop\(\)|dropDatabases\(/;

/** Whether a hook's closing gives it at least `DROP_HOOK_MS`, by name or as a longer number. */
const timedForDrops = (hook: string): boolean => {
  const bound = /\}, ([\w_]+)\);$/.exec(hook)?.[1];
  if (bound === undefined) return false;
  return bound === 'DROP_HOOK_MS' || Number(bound.replaceAll('_', '')) >= DROP_HOOK_MS;
};

const integrationFiles = (): readonly string[] =>
  Bun.spawnSync(['git', 'ls-files', '*.integration.test.ts'], { cwd: ROOT })
    .stdout.toString()
    .split('\n')
    .filter((line) => line !== '');

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

  test('every hook that drops clones has at least the time drops wait for', () => {
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, DROP_HOOK_MS);')).toBe(
      true,
    );
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, 120_000);')).toBe(
      true,
    );
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n}, 5_000);')).toBe(false);
    expect(timedForDrops('afterAll(async () => {\n  await cloned.drop();\n});')).toBe(false);
    const short = integrationFiles().filter((file) =>
      hooksOf(readFileSync(join(ROOT, file), 'utf8'), 'afterAll').some(
        (hook) => DROPS.test(hook) && !timedForDrops(hook),
      ),
    );
    expect(short).toEqual([]);
  });
});
