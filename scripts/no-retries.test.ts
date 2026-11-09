/**
 * A test that fails once is a defect, not weather (`CONTRIBUTING.md` §5). A retry turns a flaky test into a
 * green run that happens to be slower, and the first failure — the only evidence of the flake — is thrown
 * away. Five end-to-end tests were passing that way before this was written. Nothing is retried, and the
 * configuration says so in the one place that could ask for it.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('nothing is retried', () => {
  test('Playwright retries no test, in CI or anywhere', () => {
    const config = read('apps/web/playwright.config.ts');
    expect(config).toMatch(/^\s*retries: 0,$/m);
    expect(config).not.toMatch(/retries:\s*ci/);
    // With no second run, the first failure is the one to keep.
    expect(config).toMatch(/'retain-on-failure'/);
    // But the run that measures is judged on how long the page takes, and a trace is time it does not have.
    expect(config).toMatch(/trace: performanceMode === 'only' \? 'off'/);
  });

  test('no workflow and no script asks a test runner to run a test again', () => {
    const workflows = readdirSync('.github/workflows').map((name) =>
      join('.github/workflows', name),
    );
    const asking = [...workflows, 'package.json', 'apps/web/package.json']
      .filter((path) => /--retries[ =]|--retry[ =]|--rerun-each/.test(read(path)))
      .sort();
    expect(asking).toEqual([]);
  });
});
