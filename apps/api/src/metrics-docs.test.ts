/**
 * An operator learns what to watch from `CONFIG.md`, not from the code: every metric family the API serves is described there
 * (`CONTRIBUTING.md` §6.2). The families are read from where they are registered, so one added without a line fails here.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../..');
const config = readFileSync(join(ROOT, 'docs/CONFIG.md'), 'utf8');

/** A family is registered with `registry.<kind>('purlay_…'` or declared as a `name: 'purlay_…'` of a `MetricFamily`. */
const REGISTERED = /(?:registry\.\w+\(\s*|name:\s*)'(purlay_\w+)'/g;

const sourceFiles = (): string[] =>
  [...new Bun.Glob('**/*.ts').scanSync({ cwd: import.meta.dir })]
    .filter((file) => !file.endsWith('.test.ts'))
    .map((file) => join(import.meta.dir, file));

describe('the metric families', () => {
  const families = [
    ...new Set(
      sourceFiles().flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(REGISTERED)].map((match) => match[1] ?? ''),
      ),
    ),
  ];

  test('the API serves are all described in CONFIG.md', () => {
    expect(families.length).toBeGreaterThan(15);
    expect(families.filter((family) => !config.includes(`\`${family}\``))).toEqual([]);
  });
});
