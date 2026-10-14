/**
 * Every entry of `scripts/mutations.ts` still applies, and names tests that exist — checked on every
 * `verify`, in milliseconds, without running a mutation.
 *
 * `bun run mutate` reports an entry whose `find` no longer occurs exactly once as stale, but it is not
 * part of `verify`: seven entries went stale across merges before anybody ran it (#584), and each was
 * a guard nothing proved any more. Here a moved or reworded line fails the build on the change that
 * moved it, which is when its author knows what the guard became.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutate } from './mutate';
import { MUTATIONS } from './mutations';

const root = join(import.meta.dir, '..');

describe('the mutation list', () => {
  test('has entries, each with its own id', () => {
    expect(MUTATIONS.length).toBeGreaterThan(0);
    expect(new Set(MUTATIONS.map((m) => m.id)).size).toBe(MUTATIONS.length);
  });

  for (const mutation of MUTATIONS) {
    test(`${mutation.id} still applies, to exactly one place, and names tests that exist`, () => {
      const file = join(root, mutation.file);
      expect(existsSync(file), `${mutation.file} is gone`).toBe(true);
      const mutated = mutate(readFileSync(file, 'utf8'), mutation);
      expect(mutated, `its \`find\` does not occur exactly once in ${mutation.file}`).toBeDefined();
      for (const named of mutation.tests) {
        expect(existsSync(join(root, named)), `${named} is gone`).toBe(true);
      }
    });
  }
});
