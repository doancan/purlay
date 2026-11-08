import { describe, expect, test } from 'bun:test';
import { bundledModules, type BundledModule } from '../composition';
import { EXHAUSTIVE_MODULE_LIMIT, moduleCells, subsetsOf } from './module-cells';

const aModule = (id: string, requires: readonly string[] = []): BundledModule => ({
  manifest: {
    id,
    requires,
    optional: [],
    degrades: {},
    provides: [],
    budget: { none: 'a test module' },
  },
});

const idsOf = (carried: readonly BundledModule[]): string[] =>
  moduleCells(carried).map((cell) => cell.ids.join('+'));

describe('the cells of the module matrix', () => {
  test('the build’s own cells are the subsets the matrix visits that a process can start, whatever the number of modules', () => {
    const carried = bundledModules.map((module) => module.manifest.id);
    const requires = new Map(
      bundledModules.map(({ manifest }) => [manifest.id, manifest.requires]),
    );
    const startable = subsetsOf(carried).filter((ids) =>
      ids.every((id) => (requires.get(id) ?? []).every((required) => ids.includes(required))),
    );
    const cells = moduleCells(bundledModules);
    expect(cells.map((cell) => cell.ids)).toEqual(startable);
    expect(cells[0]?.ids).toEqual([]);
    expect(cells.at(-1)?.ids).toEqual(carried);
  });

  test('a third module adds its cells, with no list edited', () => {
    const two = [aModule('first'), aModule('second')];
    const three = [...two, aModule('third')];
    expect(idsOf(two)).toEqual(['', 'first', 'second', 'first+second']);
    const cells = moduleCells(three);
    expect(cells).toHaveLength(8);
    expect(cells.filter((cell) => cell.ids.includes('third'))).toHaveLength(4);
    for (const cell of cells) {
      expect(cell.composition.modules.map((module) => module.manifest.id).sort()).toEqual(
        [...cell.ids].sort(),
      );
    }
  });

  test('each cell is a MODULES value a process starts: none, unset for every module, otherwise the ids', () => {
    const cells = moduleCells([aModule('first'), aModule('second'), aModule('third')]);
    expect(cells.map((cell) => cell.setting)).toEqual([
      'none',
      'first',
      'second',
      'first,second',
      'third',
      'first,third',
      'second,third',
      undefined,
    ]);
  });

  test('a subset the registry refuses is not a cell', () => {
    const carried = [aModule('base'), aModule('extra', ['base'])];
    expect(idsOf(carried)).toEqual(['', 'base', 'base+extra']);
  });

  test('past the limit the cells are sampled: the core alone, each alone, each left out, everything', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    expect(ids.length).toBeGreaterThan(EXHAUSTIVE_MODULE_LIMIT);
    const sampled = subsetsOf(ids).map((subset) => subset.join(''));
    expect(sampled).toEqual([
      '',
      'a',
      'b',
      'c',
      'd',
      'e',
      'bcde',
      'acde',
      'abde',
      'abce',
      'abcd',
      'abcde',
    ]);
    expect(moduleCells(ids.map((id) => aModule(id)))).toHaveLength(sampled.length);
  });
});
