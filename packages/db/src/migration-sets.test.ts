import { describe, expect, test } from 'bun:test';
import { PRODUCT_MIGRATION_SETS, PRODUCT_MODULE_IDS, setsNamedBy } from './migrator';
import { ModulesSettingError, parseModulesSetting } from './modules-setting';

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
});

describe('the reading of a MODULES setting', () => {
  const known = ['chat', 'issues'];

  test('says what each refusal is, every one at once', () => {
    expect(problemsOf('none,chat')).toEqual([
      'MODULES has "none" with other items: none must stand alone',
    ]);
    expect(problemsOf('chat,calendar,chat,,CHAT')).toEqual([
      'MODULES names "calendar", which this build does not have (it has: chat, issues)',
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
