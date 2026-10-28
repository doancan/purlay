/** `test:all` in CI with the database up and Redis missing refuses, rather than leaving the Redis tests out. */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

describe('integration: test:all in CI', () => {
  test('refuses when the database answers and Redis does not', () => {
    const { exitCode, output } = testAll({
      CI: 'true',
      DATABASE_URL: process.env['DATABASE_URL'] ?? '',
      REDIS_URL: 'redis://127.0.0.1:1',
    });
    expect(exitCode).toBe(1);
    expect(output).toContain(
      'REDIS_URL is not set or nothing answers there, and CI provides Redis. Refusing',
    );
  }, 30_000);
});
