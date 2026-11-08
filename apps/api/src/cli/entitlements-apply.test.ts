/**
 * `bun run entitlements:apply --help` (D-292) prints the usage and the exit codes and succeeds without a configuration: asking how to
 * use the command must not need a database, an `APP_URL` or a key. The command applying a file is `entitlements-apply.integration.test.ts`.
 */
import { describe, expect, test } from 'bun:test';

const SCRIPT = `${import.meta.dir}/entitlements-apply.ts`;

describe('bun run entitlements:apply --help', () => {
  test('prints the usage and the exit codes with no configuration at all', () => {
    const done = Bun.spawnSync(['bun', '--no-env-file', 'run', SCRIPT, '--help'], {
      env: { PATH: process.env['PATH'] ?? '' },
    });
    expect(done.exitCode).toBe(0);
    const out = done.stdout.toString();
    expect(out).toContain('usage: bun run entitlements:apply --file <editions.json>');
    expect(out).toContain('exit codes');
    expect(done.stderr.toString()).toBe('');
  });
});
