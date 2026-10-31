/**
 * Every hook that clones the integration template is given `CLONE_HOOK_MS` (D-228): with the default five
 * seconds, a clone waiting its turn behind the other worker's on a loaded runner failed main on 2026-10-31.
 * A file added later is held to it here, not by somebody remembering.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../../..');

/** Each `beforeAll` of a file, as the text from its opening line to its closing one, at its own indent. */
const hooksOf = (text: string): readonly string[] =>
  [...text.matchAll(/^([ \t]*)beforeAll\(async \(\) => \{\n[\s\S]*?\n\1\}[^\n]*\);$/gm)].map(
    (match) => match[0],
  );

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
});
