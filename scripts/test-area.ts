/**
 * What `scripts/test-all.ts` and `scripts/coverage-floor.ts` share about running the suite by area (D-340): which
 * area a test file and a source file belong to, which area a run is, and the coverage floor `bunfig.toml` holds.
 *
 * CI runs the suite as three areas side by side, each in one `bun test` process: `web` (`apps/web`), `scripts`
 * (`scripts`, and the files that belong to no area) and `api` (`apps/api` and `packages`). A file's tests are
 * those of its own area, and the floor is judged on the one process that ran them, where Bun merges what its
 * workers measured: lcov from different processes cannot be added up (no function identity, and what a process
 * counts as found depends on what it ran), which is why the suite is divided by area and not by file.
 *
 * The floor lives in `bunfig.toml` and nowhere else. Bun applies it to every file a process loads, and a process
 * loads files of other areas (the web tests load `packages/markdown`), which that area's own tests are the ones
 * to answer for. An area therefore runs under a copy of `bunfig.toml` with the floor at zero, made from the real
 * file so that nothing else about the configuration can drift, and `coverage-floor.ts` applies the real floor, from
 * the same line, to each file in the process of the area that owns it.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The areas the suite is divided into, in the order CI lists them. */
export const AREAS = ['web', 'scripts', 'api'] as const;
export type Area = (typeof AREAS)[number];

/** Which area owns a path, by its first directories. A path outside every prefix is not owned: see `ownerOf`. */
const OWNERS: readonly { readonly prefix: string; readonly area: Area }[] = [
  { prefix: 'apps/web/', area: 'web' },
  { prefix: 'apps/api/', area: 'api' },
  // The shared packages are tested with the API: the API's tests are what exercise `packages/db`, the contract
  // types and the Markdown engine as they are used, and each file of them meets the floor on those and its own.
  { prefix: 'packages/', area: 'api' },
  { prefix: 'scripts/', area: 'scripts' },
];

/** The area that owns a source or test file, or `undefined` for a file that belongs to none (a root file, a copy in a temporary directory). */
export const ownerOf = (path: string): Area | undefined =>
  OWNERS.find((owner) => path.startsWith(owner.prefix))?.area;

/** The area a test file runs in. A test file outside every prefix would run in none: the partition test refuses one. */
export const areaOfTest = (file: string): Area | undefined => ownerOf(file);

/** Whether an area's tests need PostgreSQL and Redis. `web` needs neither: its job starts no service. */
export const needsServices = (area: Area): boolean => area !== 'web';

/** The area `PURLAY_TEST_AREA` names, or `undefined` when it is unset or empty (the whole suite, as always). */
export const parseArea = (value: string | undefined): Area | undefined => {
  if (value === undefined || value === '') return undefined;
  const area = AREAS.find((name) => name === value);
  if (area === undefined) {
    throw new Error(`PURLAY_TEST_AREA must be one of ${AREAS.join(', ')}, got "${value}"`);
  }
  return area;
};

/** Where an area writes its coverage and its summary; `coverage/` is git-ignored. */
export const areaDirectory = (area: Area): string => `coverage/area-${area}`;

/** The roots `test:all` runs, and what `bun test` takes for a test file. */
const ROOTS = ['apps', 'packages', 'scripts'];
const TEST_FILE = '**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,cjs,mjs,cts,mts}';

/** The test files on disk, by the rules `bun test` finds them by (node_modules and build output left out). */
export const testFilesOnDisk = (root = '.'): string[] => {
  const found: string[] = [];
  for (const start of ROOTS) {
    if (!existsSync(join(root, start))) continue;
    for (const file of new Bun.Glob(TEST_FILE).scanSync({
      cwd: join(root, start),
      onlyFiles: true,
    })) {
      const path = `${start}/${file}`;
      if (!/(^|\/)(node_modules|dist)\//.test(path)) found.push(path);
    }
  }
  return found.sort();
};

/** One line of `bunfig.toml` holds the floor: `coverageThreshold = { lines = 0.96, functions = 0.95 }`. */
const FLOOR_LINE =
  /^coverageThreshold[ \t]*=[ \t]*\{[ \t]*lines[ \t]*=[ \t]*([0-9.]+)[ \t]*,[ \t]*functions[ \t]*=[ \t]*([0-9.]+)[ \t]*\}[ \t]*$/m;

/** The per-file floor, as fractions. */
export interface Floor {
  readonly lines: number;
  readonly functions: number;
}

/** The floor `bunfig.toml` holds. A configuration with no such line is refused, never read as "no floor". */
export const readFloor = (bunfig: string): Floor => {
  const match = FLOOR_LINE.exec(bunfig);
  if (match === null) {
    throw new Error('bunfig.toml has no `coverageThreshold = { lines = …, functions = … }` line');
  }
  return { lines: Number(match[1]), functions: Number(match[2]) };
};

/** `bunfig.toml` with the floor at zero and everything else as it was: the configuration an area runs under. */
export const withoutFloor = (bunfig: string): string => {
  readFloor(bunfig);
  return bunfig.replace(FLOOR_LINE, 'coverageThreshold = { lines = 0.0, functions = 0.0 }');
};
