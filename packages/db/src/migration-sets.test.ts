import { readdirSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import {
  MIGRATIONS_DIRECTORY,
  PRODUCT_MIGRATION_SETS,
  PRODUCT_MODULE_IDS,
  PRODUCT_MODULE_REQUIRES,
  setsNamedBy,
} from './migrator';
import { ModulesSettingError, parseModulesSetting, unmetRequirements } from './modules-setting';
import { TABLE_OWNERS } from './table-owners';

const idsOfSets = (setting: string | undefined): string[] =>
  setsNamedBy(setting).map((set) => set.id);

const problemsOf = (setting: string | undefined): readonly string[] => {
  try {
    setsNamedBy(setting);
  } catch (error) {
    if (error instanceof ModulesSettingError) return error.problems;
    throw error;
  }
  return [];
};

describe('the migration sets a MODULES setting names', () => {
  test('unset or blank is every set the build carries', () => {
    for (const setting of [undefined, '', '   ']) {
      expect(setsNamedBy(setting)).toEqual(PRODUCT_MIGRATION_SETS);
    }
  });

  test('none is the core alone', () => {
    expect(setsNamedBy('none')).toEqual([]);
    expect(setsNamedBy(' none ')).toEqual([]);
  });

  test('a list is the sets it names, whatever its spacing and order', () => {
    expect(idsOfSets(' chat ')).toEqual(['chat']);
    expect(idsOfSets('issues, chat')).toEqual(['chat', 'issues']);
    expect(idsOfSets('issues')).toEqual(['issues']);
  });

  test('a setting the API would refuse is refused, never read as the core alone', () => {
    const refused = [
      'CHAT',
      'None',
      'chat;issues',
      'chat,calendar',
      'chat,chat',
      ',',
      ',,',
      'chat,',
    ];
    for (const setting of [...refused, 'none,chat']) {
      expect(problemsOf(setting).length).toBeGreaterThan(0);
    }
  });

  test('every set belongs to a module the build carries', () => {
    for (const set of PRODUCT_MIGRATION_SETS) expect(PRODUCT_MODULE_IDS).toContain(set.id);
  });

  test('the sets registered are the directories under migrations/, so a set cannot be made and left unregistered', () => {
    const directories = readdirSync(MIGRATIONS_DIRECTORY, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(PRODUCT_MIGRATION_SETS.map((set): string => set.id).sort()).toEqual(directories);
    for (const set of PRODUCT_MIGRATION_SETS) {
      expect(set.directory).toBe(`${MIGRATIONS_DIRECTORY}/${set.id}`);
    }
  });

  test('every set owns at least one table in TABLE_OWNERS, and every owner but the core is a set', () => {
    const owners = new Set<string>(Object.values(TABLE_OWNERS));
    for (const set of PRODUCT_MIGRATION_SETS) expect(owners).toContain(set.id);
    const setIds = new Set<string>(PRODUCT_MIGRATION_SETS.map((set) => set.id));
    for (const owner of owners) if (owner !== 'core') expect(setIds).toContain(owner);
  });
});

describe('what a module requires of another', () => {
  const requires = { chat: [], issues: ['chat'] };

  test('a selection that leaves a requirement out is refused in the words the API uses, and one that names it is not', () => {
    expect(() => setsNamedBy('issues', requires)).toThrow(ModulesSettingError);
    expect(() => setsNamedBy('issues', requires)).toThrow(
      '"issues" requires "chat", which MODULES does not enable',
    );
    expect(idsOfSets('chat,issues')).toEqual(['chat', 'issues']);
    expect(setsNamedBy('issues, chat', requires).map((set) => set.id)).toEqual(['chat', 'issues']);
    expect(setsNamedBy('chat', requires).map((set) => set.id)).toEqual(['chat']);
    expect(setsNamedBy(undefined, requires)).toEqual(PRODUCT_MIGRATION_SETS);
    expect(setsNamedBy('none', requires)).toEqual([]);
  });

  test('every unmet requirement is named at once', () => {
    expect(unmetRequirements(['b', 'c'], { a: ['x'], b: ['a', 'x'], c: ['a'] })).toEqual([
      '"b" requires "a", which MODULES does not enable',
      '"b" requires "x", which MODULES does not enable',
      '"c" requires "a", which MODULES does not enable',
    ]);
  });

  test('the table has an entry for every module of the build', () => {
    expect(Object.keys(PRODUCT_MODULE_REQUIRES).sort()).toEqual([...PRODUCT_MODULE_IDS].sort());
  });
});

describe('the reading of a MODULES setting', () => {
  const known = PRODUCT_MODULE_IDS;

  test('says what each refusal is, every one at once', () => {
    expect(problemsOf('none,chat')).toEqual([
      'MODULES has "none" with other items: none must stand alone',
    ]);
    expect(problemsOf('chat,calendar,chat,,CHAT')).toEqual([
      `MODULES names "calendar", which this build does not have (it has: ${known.join(', ')})`,
      'MODULES names "chat" twice',
      'MODULES has an empty item: a doubled or trailing comma',
      'MODULES names "CHAT", which is not a module id: lowercase letters, digits and hyphens, starting with a letter',
    ]);
    expect(problemsOf(',,')).toEqual(['MODULES has an empty item: a doubled or trailing comma']);
  });

  test('names the setting and every problem in its message', () => {
    expect(() => parseModulesSetting('none,chat', known)).toThrow(
      /^MODULES cannot start this process:\n {2}- MODULES has "none" with other items/,
    );
  });

  test('a build with no module says so', () => {
    expect(() => parseModulesSetting('chat', [])).toThrow('(it has: none)');
  });

  test('returns the trimmed ids in the order given', () => {
    expect(parseModulesSetting(' issues , chat ', known)).toEqual({
      kind: 'named',
      ids: ['issues', 'chat'],
    });
    expect(parseModulesSetting(undefined, known)).toEqual({ kind: 'all' });
    expect(parseModulesSetting('none', known)).toEqual({ kind: 'none' });
  });
});
