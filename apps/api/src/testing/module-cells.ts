/**
 * The cells of the module matrix (D-250 rule 6, `MODULES.md` §5), made from the modules a build carries: one for every
 * `MODULES` value that process can start, so a module added to the bundle adds its cells to every test that walks them
 * and no test lists a module by hand.
 *
 * A cell is a subset of the bundle, resolved the way a process resolves it: through `composeFor`, which reads the
 * setting with `parseModulesSetting` and checks what each module requires of another. A subset the registry refuses
 * (a module without the partner it requires) is not a value an operator can run, so it is not a cell.
 */
import { composeFor, type BundledModule, type Composition } from '../composition';
import { CORE_CLAIMS } from '../platform/module-kit/core-claims';
import { ModuleConfigError, moduleRegistry } from '../platform/module-kit/registry';

/**
 * `carried` in the order a process starts them: partners first, then by id (the registry's). A module is added to a list where its
 * author puts it and a name sorts where it sorts, so what a process reports it runs is compared with this and not with the list.
 */
export const inStartOrder = (carried: readonly BundledModule[]): readonly BundledModule[] =>
  moduleRegistry(
    carried.map((module) => module.manifest),
    CORE_CLAIMS,
  )
    .resolve(undefined)
    .flatMap((manifest) => carried.filter((module) => module.manifest === manifest));

/**
 * Up to this many modules every subset is a cell (2^n of them). Beyond it the matrix would grow faster than the
 * databases each cell needs can be made — a test is a database per database-cell, and a process per run-cell, and the
 * two are crossed — so the cells are sampled instead (`subsetsOf`).
 */
export const EXHAUSTIVE_MODULE_LIMIT = 3;

export interface ModuleCell {
  /** The modules it runs, in the bundle's order. */
  readonly ids: readonly string[];
  /** The `MODULES` value that starts it: unset for every module, `none` for the core alone, else the ids. */
  readonly setting: string | undefined;
  readonly composition: Composition;
  /** What a test calls it: the core alone, or the modules it runs. */
  readonly label: string;
}

/**
 * The subsets of `ids` the matrix visits. All of them while there are few; past `EXHAUSTIVE_MODULE_LIMIT` the core
 * alone, each module alone, each module left out, and everything — the shapes where one module's set or hooks are the
 * difference, which is what the matrix is there to find. Every subset has one name: the set of ids, in the order given.
 */
export const subsetsOf = (ids: readonly string[]): readonly (readonly string[])[] => {
  if (ids.length <= EXHAUSTIVE_MODULE_LIMIT) {
    return Array.from({ length: 2 ** ids.length }, (_, mask) =>
      ids.filter((_id, position) => (mask >> position) % 2 === 1),
    );
  }
  return [
    [],
    ...ids.map((id) => [id]),
    ...ids.map((left) => ids.filter((id) => id !== left)),
    [...ids],
  ];
};

const settingOf = (ids: readonly string[], carried: number): string | undefined => {
  if (ids.length === 0) return 'none';
  return ids.length === carried ? undefined : ids.join(',');
};

const labelOf = (ids: readonly string[], carried: number): string => {
  if (ids.length === 0) return 'the core alone';
  return ids.length === carried ? `every module (${ids.join(', ')})` : ids.join(' and ');
};

/** Every cell of the matrix for the modules a build carries, the core alone first and everything last where all are cells. */
export const moduleCells = (carried: readonly BundledModule[]): readonly ModuleCell[] => {
  const cells: ModuleCell[] = [];
  for (const ids of subsetsOf(carried.map((module) => module.manifest.id))) {
    const setting = settingOf(ids, carried.length);
    try {
      cells.push({
        ids,
        setting,
        composition: composeFor(carried, setting),
        label: labelOf(ids, carried.length),
      });
    } catch (error) {
      if (!(error instanceof ModuleConfigError)) throw error;
    }
  }
  return cells;
};
