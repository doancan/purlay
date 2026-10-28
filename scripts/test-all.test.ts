/**
 * `test:all` in CI with a test service missing: a refusal, not half a suite reported as the whole one.
 * The case with a database and no Redis needs a database, and is `test-all.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs the script itself with only the environment given; it must refuse before starting a test. */
const testAll = (environment: Record<string, string>): { exitCode: number; output: string } => {
  // From an empty directory: a run that fails to refuse finds no tests there, and ends at once,
  // rather than running this suite — and this test — again underneath itself.
  const done = Bun.spawnSync(['bun', '--no-env-file', join(import.meta.dir, 'test-all.ts')], {
    cwd: mkdtempSync(join(tmpdir(), 'test-all-')),
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', ...environment },
    timeout: 20_000,
  });
  return { exitCode: done.exitCode, output: `${done.stdout.toString()}${done.stderr.toString()}` };
};

describe('test:all in CI', () => {
  test('refuses when DATABASE_URL is not set', () => {
    const { exitCode, output } = testAll({ CI: 'true' });
    expect(exitCode).toBe(1);
    expect(output).toContain('DATABASE_URL is not set, and CI provides the database. Refusing');
  });

  test('refuses when nothing answers at the database', () => {
    const { exitCode, output } = testAll({
      CI: 'true',
      DATABASE_URL: 'postgres://nobody@127.0.0.1:1/none',
    });
    expect(exitCode).toBe(1);
    expect(output).toContain(
      'nothing answers at 127.0.0.1:1, and CI provides the database. Refusing',
    );
  });
});
