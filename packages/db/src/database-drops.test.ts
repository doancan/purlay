/**
 * A test that drops a database it has just closed a pool on must not do it by hand: the pool says it has ended before its
 * socket has, `drop database ... with (force)` then kills the connection halfway through hanging up, and the client reads a
 * fatal "terminating connection due to administrator command" (57P01) with nobody listening — the run dies of an unhandled
 * error in whichever test is running. It failed `client.integration.test.ts` one run in twelve under load; `dropDatabases`
 * (`testing.ts`) waits for the connections to go first. A file below may drop by hand only for the reason given.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'bun:test';

const ROOT = join(import.meta.dir, '../../..');
const ALLOWED: Readonly<Record<string, string>> = {
  'packages/db/src/testing.ts': 'dropDatabases itself, after backendsGone',
  'packages/db/src/harness.integration.test.ts':
    'calls backendsGone before the drop, and tests that wait',
};

const filesUnder = (directory: string): string[] =>
  readdirSync(directory).flatMap((entry) => {
    if (entry === 'node_modules') return [];
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });

describe('how a test drops a database', () => {
  test('is through dropDatabases, except where a reason says otherwise', () => {
    const byHand = ['apps', 'packages']
      .flatMap((top) => filesUnder(join(ROOT, top)))
      .filter((file) => /\.test\.tsx?$|[\\/]testing\.ts$/.test(file))
      .filter((file) => /drop database[^`'"]*with \(force\)/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(ROOT, file))
      .filter((file) => !(file in ALLOWED) && file !== relative(ROOT, import.meta.path));
    expect(byHand).toEqual([]);
  });
});
