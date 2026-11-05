/**
 * No browser test chooses a path by an instant question to the page (`e2e-probes.ts`).
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { instantProbes } from './e2e-probes';

const E2E = join(import.meta.dir, '../apps/web/e2e');

describe('the browser tests', () => {
  test('are found, so that the rule below is applied to something', () => {
    const files = readdirSync(E2E).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain('support.ts');
  });

  test('never choose a path by `isVisible()` or `isHidden()`', () => {
    const found = readdirSync(E2E)
      .filter((name) => name.endsWith('.ts'))
      .flatMap((name) =>
        instantProbes(readFileSync(join(E2E, name), 'utf8')).map(
          (line) => `${name}:${String(line)}`,
        ),
      );
    expect(found).toEqual([]);
  });
});

describe('the rule', () => {
  test.each([
    'if (await toggle.isVisible()) await toggle.click();',
    'while ((await found.count()) === 0 && (await older.isVisible())) {',
    'const open = await dialog.isHidden();',
    'if (await toggle\n  .isVisible()) {',
  ])('refuses %s', (source) => {
    expect(instantProbes(source).length).toBeGreaterThan(0);
  });

  test('lets a wait and a comment about the question through', () => {
    expect(
      instantProbes(
        [
          'await expect(toggle).toBeVisible();',
          '// not isVisible() — it answers for this instant',
          'await expect(dialog).toBeHidden();',
        ].join('\n'),
      ),
    ).toEqual([]);
  });
});
