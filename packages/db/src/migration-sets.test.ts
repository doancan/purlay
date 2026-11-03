import { describe, expect, test } from 'bun:test';
import { PRODUCT_MIGRATION_SETS, setsNamedBy } from './migrator';

describe('the migration sets a MODULES setting names', () => {
  test('unset or blank is every set the build carries', () => {
    for (const setting of [undefined, '', ' , ']) {
      expect(setsNamedBy(setting)).toEqual(PRODUCT_MIGRATION_SETS);
    }
  });

  test('none is the core alone', () => {
    expect(setsNamedBy('none')).toEqual([]);
    expect(setsNamedBy(' none ')).toEqual([]);
  });

  test('a list is the sets it names, whatever its spacing and order', () => {
    expect(setsNamedBy(' chat ').map((set) => set.id)).toEqual(['chat']);
    expect(setsNamedBy('chat,chat').map((set) => set.id)).toEqual(['chat']);
  });

  test('a word that names no set adds none: the API refuses the setting itself', () => {
    expect(setsNamedBy('calendar')).toEqual([]);
    expect(setsNamedBy('chat,calendar').map((set) => set.id)).toEqual(['chat']);
  });
});
