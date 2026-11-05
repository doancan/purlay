/**
 * Every entry of `scripts/mutations/` still applies, and names tests that exist — checked on every
 * `verify`, in milliseconds, without running a mutation.
 *
 * `bun run mutate` reports an entry whose `find` no longer occurs exactly once as stale, but it is not
 * part of `verify`: seven entries went stale across merges before anybody ran it (#584), and each was
 * a guard nothing proved any more. Here a moved or reworded line fails the build on the change that
 * moved it, which is when its author knows what the guard became.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mutate } from './mutate';
import { MUTATIONS, MUTATIONS_BY_AREA } from './mutations';
import { AREAS, areaOf } from './mutations/areas';

const root = join(import.meta.dir, '..');
const directory = join(import.meta.dir, 'mutations');
const NOT_AREA_FILES = ['areas.ts', 'index.ts', 'shared.ts'];

describe('the mutation list', () => {
  test('has entries, each with its own id', () => {
    expect(MUTATIONS.length).toBeGreaterThan(0);
    expect(new Set(MUTATIONS.map((m) => m.id)).size).toBe(MUTATIONS.length);
  });

  for (const [area, entries] of Object.entries(MUTATIONS_BY_AREA)) {
    test(`${area}: every entry belongs in this file, and the ids ascend`, () => {
      expect(entries.length, `${area} has no entry: remove it from areas.ts`).toBeGreaterThan(0);
      for (const entry of entries) {
        const belongsIn: string = areaOf(entry.file);
        expect(
          belongsIn,
          `${entry.id} mutates ${entry.file}: it belongs in scripts/mutations/${belongsIn}.ts`,
        ).toBe(area);
      }
      const ids = entries.map((entry) => entry.id);
      for (let at = 1; at < ids.length; at += 1) {
        const [before, after] = [ids[at - 1]!, ids[at]!];
        expect(
          before < after,
          `${after} is out of order after ${before}: insert an entry where its id sorts, not at the end`,
        ).toBe(true);
      }
    });
  }

  test('index.ts imports every file of the directory, and the areas name them', () => {
    const files = readdirSync(directory)
      .filter((name) => name.endsWith('.ts') && !NOT_AREA_FILES.includes(name))
      .map((name) => name.replace(/\.ts$/, ''))
      .sort();
    const imported = [
      ...readFileSync(join(directory, 'index.ts'), 'utf8').matchAll(/from '\.\/([^']+)'/g),
    ]
      .map((match) => match[1]!)
      .filter((name) => !NOT_AREA_FILES.includes(`${name}.ts`))
      .sort();
    expect(imported).toEqual(files);
    const named: string[] = AREAS.map((area) => area.name);
    expect(named.sort()).toEqual(files);
  });

  for (const mutation of MUTATIONS) {
    test(`${areaOf(mutation.file)}: ${mutation.id} still applies, to exactly one place, and names tests that exist`, () => {
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

describe('areaOf', () => {
  test('the longest matching prefix wins', () => {
    expect(areaOf('apps/api/src/features/chat/messages/messages.ts')).toBe('api-chat-messages');
    expect(areaOf('apps/api/src/features/chat/module.ts')).toBe('api-chat');
    expect(areaOf('apps/api/src/modules/auth/better-auth.ts')).toBe('api-modules-auth-better-auth');
    expect(areaOf('apps/api/src/modules/auth/oidc.ts')).toBe('api-modules-auth');
  });

  test('a file no area covers is refused, and the message says what to add', () => {
    expect(() => areaOf('somewhere/new/file.ts')).toThrow('scripts/mutations/areas.ts');
  });

  test('no prefix is listed twice, so no file has two answers', () => {
    const prefixes = AREAS.flatMap((area) => area.prefixes);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
