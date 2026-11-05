/**
 * `bun run db:migrate` and the API read the one `MODULES` setting, and once read it twice: `CHAT` migrated the
 * core alone and said "nothing to apply" while the API refused it. This holds them as a pair over a table — for
 * every input, the command refuses exactly when the API does, a missing requirement included: the command's table of
 * requirements is held to the manifests here (`MODULES.md` §3).
 */
import { describe, expect, test } from 'bun:test';
import {
  PRODUCT_MIGRATION_SETS,
  PRODUCT_MODULE_IDS,
  PRODUCT_MODULE_REQUIRES,
  setsNamedBy,
} from '@purlay/db';
import { bundledModules, registry } from './composition';
import { moduleRegistry } from './platform/module-kit/registry';

const migrateRefuses = (setting: string | undefined): boolean => {
  try {
    setsNamedBy(setting);
    return false;
  } catch {
    return true;
  }
};

const apiRefuses = (setting: string | undefined): boolean => {
  try {
    registry.resolve(setting);
    return false;
  } catch {
    return true;
  }
};

const ACCEPTED: readonly (string | undefined)[] = [
  undefined,
  '',
  '   ',
  'none',
  ' none ',
  'chat',
  ' chat ',
  'issues',
  'chat,issues',
  'issues, chat',
  ' chat , issues ',
];

const REFUSED: readonly string[] = [
  'CHAT',
  'Chat',
  'None',
  'NONE',
  'chat;issues',
  'chat issues',
  'chat,calendar',
  'calendar',
  'chat,chat',
  'none,chat',
  'chat,none',
  'none,none',
  'chat,',
  ',chat',
  ',',
  ',,',
  ' , ',
  'chat,,issues',
  '1chat',
  '-chat',
  'chat_issues',
  'çhat',
  'a'.repeat(33),
];

describe('db:migrate and the API read MODULES alike', () => {
  test.each(ACCEPTED)('both accept %p', (setting) => {
    expect(migrateRefuses(setting)).toBe(false);
    expect(apiRefuses(setting)).toBe(false);
  });

  test.each(REFUSED)('both refuse %p', (setting) => {
    expect(migrateRefuses(setting)).toBe(true);
    expect(apiRefuses(setting)).toBe(true);
  });

  test('both give the same reasons', () => {
    for (const setting of REFUSED) {
      let migrate: readonly string[] = [];
      try {
        setsNamedBy(setting);
      } catch (error) {
        migrate = (error as { problems: readonly string[] }).problems;
      }
      let api: readonly string[] = [];
      try {
        registry.resolve(setting);
      } catch (error) {
        api = (error as { problems: readonly string[] }).problems;
      }
      expect(api).toEqual(migrate);
    }
  });

  test('the sets migrated are the modules the API starts that keep a set', () => {
    for (const setting of ACCEPTED) {
      const started = new Set(registry.resolve(setting).map((module) => module.id));
      const migrated = setsNamedBy(setting).map((set) => set.id);
      expect(migrated).toEqual(
        PRODUCT_MIGRATION_SETS.filter((set) => started.has(set.id)).map((set) => set.id),
      );
    }
  });

  test('the ids the migrator knows are the modules the build carries', () => {
    expect([...PRODUCT_MODULE_IDS].sort()).toEqual(
      bundledModules.map((module) => module.manifest.id).sort(),
    );
  });

  test('the requirements the migrator knows are the manifests', () => {
    expect(PRODUCT_MODULE_REQUIRES).toEqual(
      Object.fromEntries(
        bundledModules.map((module) => [module.manifest.id, [...module.manifest.requires]]),
      ),
    );
  });

  test('a module without its requirement is refused by both, in the same words', () => {
    const [first, second] = bundledModules.map((module) => module.manifest);
    const requires = { [first!.id]: [], [second!.id]: [first!.id] };
    const needing = moduleRegistry([
      { ...first!, requires: [] },
      { ...second!, requires: [first!.id] },
    ]);
    const problemsOf = (run: () => unknown): readonly string[] => {
      try {
        run();
      } catch (error) {
        return (error as { problems: readonly string[] }).problems;
      }
      return [];
    };
    for (const setting of [
      second!.id,
      `${first!.id},${second!.id}`,
      first!.id,
      'none',
      undefined,
    ]) {
      expect(problemsOf(() => setsNamedBy(setting, requires))).toEqual(
        problemsOf(() => needing.resolve(setting)),
      );
    }
    expect(problemsOf(() => setsNamedBy(second!.id, requires))).toEqual([
      `"${second!.id}" requires "${first!.id}", which MODULES does not enable`,
    ]);
  });
});
