/**
 * `bun run db:migrate` and the API read the one `MODULES` setting, and once read it twice: `CHAT` migrated the
 * core alone and said "nothing to apply" while the API refused it. This holds them as a pair over a table — for
 * every input, the command refuses exactly when the API does, bar what a module requires of another, which only
 * the API's manifests can say (`MODULES.md` §3).
 */
import { describe, expect, test } from 'bun:test';
import { PRODUCT_MIGRATION_SETS, PRODUCT_MODULE_IDS, setsNamedBy } from '@purlay/db';
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

  test('only the API checks what a module requires of another', () => {
    const [first, second] = bundledModules.map((module) => module.manifest);
    const needing = moduleRegistry([
      { ...first!, requires: [] },
      { ...second!, requires: [first!.id] },
    ]);
    expect(() => needing.resolve(second!.id)).toThrow('requires');
    expect(migrateRefuses(second!.id)).toBe(false);
  });
});
