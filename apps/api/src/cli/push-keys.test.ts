/**
 * `bun run push:keys` prints what the configuration takes: a pair the loader accepts as one.
 * Run a few times, so a key whose scalar has a leading zero byte would show.
 */
import { describe, expect, test } from 'bun:test';
import { DEVELOPMENT_ENCRYPTION_KEY, loadConfig } from '../platform/config';

const environment = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://purlay:purlay@localhost:5432/purlay',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  ENCRYPTION_KEY: DEVELOPMENT_ENCRYPTION_KEY,
};

const printed = (): Record<string, string> => {
  const run = Bun.spawnSync(['bun', '--no-env-file', 'run', `${import.meta.dir}/push-keys.ts`]);
  expect(run.exitCode).toBe(0);
  return Object.fromEntries(
    run.stdout
      .toString()
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
};

describe('bun run push:keys', () => {
  test('prints a pair the configuration accepts', () => {
    for (let run = 0; run < 3; run += 1) {
      const keys = printed();
      expect(Object.keys(keys)).toEqual(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY']);
      const config = loadConfig({
        ...environment,
        ...keys,
        VAPID_SUBJECT: 'mailto:ops@example.com',
      });
      expect(config.VAPID_PUBLIC_KEY).toBe(keys['VAPID_PUBLIC_KEY']);
    }
  });
});
